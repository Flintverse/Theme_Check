// Live progress file, the push to Cloudflare, the Cloudflare Functions (with a fake R2 bucket), and the Live tab in Chrome.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { Progress, readProgress } = require('../src/store/progress');
const sync = require('../src/sync');
const { listen } = require('../src/server');

const SRC = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-live-'));

test('progress: themes move queued, setup, testing, done; counts and ETA follow', () => {
  const dir = tmp();
  const p = new Progress(dir, { runId: 'r1', env: 'staging' });
  p.setThemes([{ name: 'Dawn', batch: 1 }, { name: 'Craft', batch: 1 }, { name: 'Rise', batch: 1 }]);
  p.setTheme('Dawn', { status: 'setup', step: 'Tab 2' });
  p.setTheme('Dawn', { status: 'testing', step: 'Checking vertical' });
  p.addResults('Dawn', [{ status: 'pass' }, { status: 'fail' }, { status: 'error' }, { status: 'na' }]);
  let s = readProgress(dir);
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.current.theme, 'Dawn');
  assert.deepStrictEqual(s.totals, { pass: 1, fail: 2, na: 1, review: 0 });
  assert.strictEqual(s.themes[0].fail, 2);
  assert.strictEqual(s.counts.done, 0);
  assert.strictEqual(s.etaMinutes, null, 'no estimate before one theme is finished');
  p.s.themes[0].startedAt = new Date(Date.now() - 10 * 60000).toISOString();
  p.setTheme('Dawn', { status: 'done', step: 'finished' });
  s = readProgress(dir);
  assert.strictEqual(s.counts.done, 1);
  assert.strictEqual(s.counts.left, 2);
  assert.ok(s.etaMinutes >= 19 && s.etaMinutes <= 21, 'about 10 min x 2 themes left: ' + s.etaMinutes);
  assert.strictEqual(s.current, null);
  p.finish('completed');
  s = readProgress(dir);
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.outcome, 'completed');
});

test('progress: a "running" file whose process is gone is reported as stopped unexpectedly', () => {
  const dir = tmp();
  const p = new Progress(dir, { runId: 'r2', env: 'staging', pid: 2147483000 });
  p.setThemes([{ name: 'Dawn', batch: 1 }]);
  const s = readProgress(dir);
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.outcome, 'stopped-unexpectedly');
  assert.strictEqual(readProgress(tmp()), null);
});

test('progress: keeps only the last 80 events and never shows a half-written file', () => {
  const dir = tmp();
  const p = new Progress(dir, { runId: 'r3' });
  for (let i = 0; i < 120; i++) p.event('step ' + i);
  assert.strictEqual(readProgress(dir).events.length, 80);
  assert.ok(!fs.existsSync(path.join(dir, 'progress.json.tmp')));
});

test('sync config: needs url and token; Access headers only when both parts are set', () => {
  assert.strictEqual(sync.syncConfig({}, {}), null);
  assert.strictEqual(sync.syncConfig({ cloudflare: { url: 'https://FILL-ME' } }, { THEME_CHECK_TOKEN: 'x' }), null);
  assert.match(sync.syncConfig({ cloudflare: { url: 'https://a.pages.dev' } }, {}).error, /THEME_CHECK_TOKEN/);
  const c = sync.syncConfig({ cloudflare: { url: 'https://a.pages.dev/' } }, { THEME_CHECK_TOKEN: 'tok', CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 'sec' });
  assert.strictEqual(c.base, 'https://a.pages.dev');
  assert.strictEqual(c.headers.Authorization, 'Bearer tok');
  assert.strictEqual(c.everyMs, 30000, 'progress is sent about every 30 s by default');
  assert.strictEqual(sync.syncConfig({ cloudflare: { url: 'https://a.pages.dev', progressEverySeconds: 1 } }, { THEME_CHECK_TOKEN: 'tok' }).everyMs, 10000, 'never faster than 10 s');
  assert.strictEqual(c.headers['CF-Access-Client-Id'], 'id');
  assert.ok(!sync.syncConfig({ cloudflare: { url: 'https://a.pages.dev' } }, { THEME_CHECK_TOKEN: 'tok', CF_ACCESS_CLIENT_ID: 'id' }).headers['CF-Access-Client-Id']);
});

test('push: progress is throttled, the last state always goes out, a failing monitor never breaks the run', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true }; };
  const s = { base: 'https://x.dev', headers: { Authorization: 'Bearer t' } };
  const push = sync.createProgressPusher(s, { everyMs: 60000, fetchImpl });
  push({ running: true, n: 1 });
  push({ running: true, n: 2 });
  push({ running: true, n: 3 });
  push({ running: false, n: 4 });
  await push.done();
  assert.deepStrictEqual(calls.map((c) => JSON.parse(c.body).n), [1, 4], 'first and final only inside the window');
  assert.match(calls[0].url, /\/api\/ingest\/progress$/);
  const msgs = [];
  const bad = sync.createProgressPusher(s, { everyMs: 0, fetchImpl: async () => ({ ok: false, status: 500 }), onError: (m) => msgs.push(m) });
  bad({ running: true }); bad({ running: true });
  await bad.done();
  assert.strictEqual(msgs.length, 1, 'warns once');
});

test('push: run files are uploaded (reports and pictures only, never videos), and failures are reported', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'dawn'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.html'), '<html>');
  fs.writeFileSync(path.join(dir, 'summary.json'), '{}');
  fs.writeFileSync(path.join(dir, 'dawn', 'a.png'), 'p');
  fs.writeFileSync(path.join(dir, 'dawn', 'old-video.webm'), 'v');
  const seen = [];
  const f = async (url) => { seen.push(url.split('/api/ingest/')[1]); return { ok: !/a\.png/.test(url), status: 500 }; };
  const r = await sync.pushRunFiles({ base: 'https://x.dev', headers: {} }, dir, 'run1', { fetchImpl: f });
  assert.deepStrictEqual(seen.sort(), ['media/run1/dawn/a.png', 'media/run1/report.html', 'media/run1/summary.json']);
  assert.strictEqual(r.uploaded, 2);
  assert.strictEqual(r.failed.length, 1);
});

// ---- Cloudflare Functions against a fake R2 bucket
function fakeR2() {
  const m = new Map();
  return {
    m,
    async put(k, body, opts) { const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer()); m.set(k, { buf, opts }); },
    async get(k) { const o = m.get(k); return o ? { body: o.buf, text: async () => o.buf.toString() } : null; },
  };
}
const TOKEN = 'a-long-test-token-1234567890';
const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

test('cloudflare ingest: refuses without the token, stores progress, state and pictures; serves them back', async () => {
  const env = { STORE: fakeR2(), INGEST_TOKEN: TOKEN };
  const ingest = await imp('functions/api/ingest/[[path]].js');
  const req = (method, body, auth) => new Request('https://x.dev/api/ingest/x', { method, body, headers: auth === false ? {} : { authorization: 'Bearer ' + (auth || TOKEN) } });
  const post = (p, body, auth, e) => ingest.onRequestPost({ request: req('POST', body, auth), env: e || env, params: { path: [p] } });
  const put = (parts, body) => ingest.onRequestPut({ request: req('PUT', body), env, params: { path: parts } });
  assert.strictEqual((await post('ping', '{}', false)).status, 401);
  assert.strictEqual((await post('ping', '{}', 'wrong-token-wrong-token-1')).status, 401);
  assert.strictEqual((await post('ping', '{}', undefined, { STORE: env.STORE })).status, 401, 'no secret configured means nobody gets in');
  assert.strictEqual((await post('ping', '{}')).status, 200);
  assert.strictEqual((await post('progress', 'not json')).status, 400);
  assert.strictEqual((await post('progress', JSON.stringify({ running: true, runId: 'r' }))).status, 200);
  assert.strictEqual((await post('state', JSON.stringify({ runs: [{ runId: 'r' }] }))).status, 200);
  assert.strictEqual((await put(['media', 'run1', 'report.html'], '<html>report')).status, 200);
  assert.strictEqual((await put(['media', 'run1', 'dawn', 'a.png'], 'png-bytes')).status, 200);
  assert.strictEqual((await put(['media', 'run1', 'dawn', 'video.webm'], 'v')).status, 415, 'videos are refused');
  assert.strictEqual((await put(['media', 'run1', '..', 'etc.png'], 'x')).status, 400, 'path traversal refused');
  assert.strictEqual((await put(['media', 'only-one-part'], 'x')).status, 400);
  assert.strictEqual(env.STORE.m.get('runs/run1/report.html').opts.httpMetadata.contentType, 'text/html; charset=utf-8');
  assert.strictEqual(env.STORE.m.get('runs/run1/dawn/a.png').opts.httpMetadata.contentType, 'image/png');

  const get = (fn, e, headers) => fn.onRequestGet({ request: new Request('https://x.dev/api/x', { headers: headers || {} }), env: e, params: { path: ['run1', 'report.html'] } });
  const state = await imp('functions/api/state.js');
  assert.deepStrictEqual((await (await get(state, env)).json()).runs, [{ runId: 'r' }]);
  const empty = await (await get(state, { STORE: fakeR2() })).json();
  assert.strictEqual(empty.readOnly, true, 'empty state before the first push');
  assert.strictEqual(empty.mediaLocal, true);
  const progress = await imp('functions/api/progress.js');
  assert.strictEqual((await (await get(progress, env)).json()).running, true);
  env.STORE.m.set('data/progress.json', { buf: Buffer.from(JSON.stringify({ running: true, updatedAt: new Date(Date.now() - 11 * 60000).toISOString() })), opts: {} });
  const stale = await (await get(progress, env)).json();
  assert.strictEqual(stale.running, false);
  assert.strictEqual(stale.phase, 'stalled');
  const runs = await imp('functions/runs/[[path]].js');
  const rep = await get(runs, env);
  assert.strictEqual(rep.status, 200);
  assert.match(rep.headers.get('content-security-policy'), /default-src 'none'/);
  assert.strictEqual((await runs.onRequestGet({ request: new Request('https://x.dev/runs/x'), env, params: { path: ['run1', 'nope.png'] } })).status, 404);
  assert.strictEqual((await runs.onRequestGet({ request: new Request('https://x.dev/runs/x'), env, params: { path: ['..', 'data', 'state.json'] } })).status, 404);
});

test('cloudflare reading: with READ_KEY set, data and pictures need the team code (header or login cookie)', async () => {
  const env = { STORE: fakeR2(), READ_KEY: 'team-code-1234' };
  await env.STORE.put('data/state.json', JSON.stringify({ runs: [{ runId: 'secret-run' }] }));
  await env.STORE.put('runs/run1/a.png', 'png', { httpMetadata: { contentType: 'image/png' } });
  const state = await imp('functions/api/state.js');
  const progress = await imp('functions/api/progress.js');
  const runs = await imp('functions/runs/[[path]].js');
  const login = await imp('functions/api/login.js');
  const call = (fn, headers, params) => fn.onRequestGet({ request: new Request('https://x.dev/api/x', { headers: headers || {} }), env, params: params || {} });
  assert.strictEqual((await call(state)).status, 401);
  assert.strictEqual((await call(state, { 'x-access-key': 'wrong-code-9999' })).status, 401);
  assert.strictEqual((await call(progress)).status, 401);
  assert.strictEqual((await call(runs, {}, { path: ['run1', 'a.png'] })).status, 401, 'pictures are protected too');
  assert.strictEqual((await call(state, { 'x-access-key': 'team-code-1234' })).status, 200);
  const bad = await login.onRequestPost({ request: new Request('https://x.dev/api/login', { method: 'POST', body: JSON.stringify({ code: 'not-the-code-1' }) }), env });
  assert.strictEqual(bad.status, 401);
  const good = await login.onRequestPost({ request: new Request('https://x.dev/api/login', { method: 'POST', body: JSON.stringify({ code: 'team-code-1234' }) }), env });
  assert.strictEqual(good.status, 200);
  const setCookie = good.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.strictEqual((await call(state, { cookie })).status, 200, 'the cookie unlocks the data');
  assert.strictEqual((await call(runs, { cookie }, { path: ['run1', 'a.png'] })).status, 200, 'and the pictures');
  assert.strictEqual((await call(state, { cookie: 'tc_auth=' + 'a'.repeat(64) })).status, 401, 'a made-up cookie does not');
});

// ---- the Live tab
test('the Live tab shows run progress theme by theme, and a banner on the other tabs', async () => {
  const root = tmp();
  ['config', 'checklist', 'ui'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  const p = new Progress(path.join(root, 'history', 'data'), { runId: '2026-11-18-staging', env: 'staging', mode: 'background' });
  p.setThemes([{ name: 'Dawn', batch: 1 }, { name: 'Craft', batch: 1 }, { name: 'Rise', batch: 1 }, { name: 'Pebble', batch: 1 }]);
  p.s.themes[0].startedAt = new Date(Date.now() - 9 * 60000).toISOString();
  p.setTheme('Dawn', { status: 'done', step: 'finished' });
  p.setTheme('Craft', { status: 'testing', step: 'Checking the horizontal layout (desktop)' });
  p.addResults('Craft', [{ status: 'pass' }, { status: 'fail' }, { status: 'review' }]);
  p.setTheme('Rise', { status: 'failed', step: 'not_in_findter_theme_list: no Rise' });
  p.event('Craft: layout horizontal');
  const server = await listen(root, 0, { spawnRun: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const api = await (await fetch(base + '/api/progress')).json();
    assert.strictEqual(api.running, true);
    assert.strictEqual(api.counts.total, 4);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('main h2') && /Live progress/.test(document.querySelector('main h2').textContent));
    const txt = await page.textContent('main');
    assert.match(txt, /2 of 4 themes done/);
    assert.match(txt, /Craft.*Checking the horizontal layout/);
    assert.match(txt, /not_in_findter_theme_list/);
    assert.match(await page.textContent('main h2'), /RUNNING/);
    assert.match(txt, /about \d+ min left/);
    await page.screenshot({ path: path.join(SRC, 'test', '_ui-live.png'), fullPage: true });
    await page.click('nav a[href="#overview"]');
    await page.waitForFunction(() => document.querySelector('#banner') && /A check is running/.test(document.querySelector('#banner').textContent));
    // the run ends: the page notices without a reload
    p.event('Finished');
    p.finish('completed');
    await page.click('nav a[href="#live"]');
    await page.waitForFunction(() => /FINISHED/.test(document.querySelector('main h2').textContent), null, { timeout: 20000 });
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); server.close(); }
});

test('the Cloudflare copy: login with the team code (cookie), then pictures show inline from /runs', async () => {
  const http = require('http');
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const state = { readOnly: true, mediaLocal: true, envs: ['staging'], themes: [], schedule: { description: 'x' }, runs: [{ runId: '2026-11-18-staging', env: 'staging', date: '2026-11-18', startedAt: '2026-11-18T01:00:00Z', themesTotal: 1, themesTested: 1, themesWithIssues: 1, failedChecks: 1, newCount: 1, fixedCount: 0, worstThemes: [{ theme: 'Dawn', fails: 1 }], topChecks: [{ id: 'V-10', title: 'Selected looks selected', severity: 'critical', themes: 1 }], fixed: [], setupFailures: [] }], issues: { items: { 'staging|Dawn|vertical|V-10': { env: 'staging', theme: 'Dawn', layout: 'vertical', id: 'V-10', title: 'Selected looks selected', severity: 'critical', status: 'open', firstSeen: '2026-11-18', lastSeen: '2026-11-18', lastRun: '2026-11-18-staging', history: [{ s: 'fail', date: '2026-11-18' }], evidence: { run: '2026-11-18-staging', shots: ['dawn/a.png'] } } } }, themeStatus: [], checklist: [], library: {} };
  const authed = (req) => /(^|;\s*)tc_auth=ok123/.test(req.headers.cookie || '');
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/login') {
      let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
        const ok = JSON.parse(b).code === 'team-code-1234';
        res.writeHead(ok ? 200 : 401, Object.assign({ 'Content-Type': 'application/json' }, ok ? { 'Set-Cookie': 'tc_auth=ok123; Path=/; HttpOnly' } : {}));
        res.end(ok ? '{"ok":true}' : '{"error":"wrong code"}');
      });
      return;
    }
    if (req.url.startsWith('/api/state') || req.url.startsWith('/api/progress')) {
      if (!authed(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"access code needed"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(req.url.startsWith('/api/progress') ? '{"running":false,"none":true}' : JSON.stringify(state));
    }
    if (req.url.startsWith('/runs/')) {
      if (!authed(req)) { res.writeHead(401); return res.end('no'); }
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForSelector('#k-in');
    assert.ok(!(await page.textContent('main')).includes('Dawn'), 'no data before the code');
    await page.fill('#k-in', 'wrong-code-9999');
    await page.click('#k-go');
    await page.waitForFunction(() => /not accepted/.test(document.querySelector('main').textContent));
    await page.fill('#k-in', 'team-code-1234');
    await page.click('#k-go');
    await page.waitForSelector('.kpis');
    assert.match(await page.textContent('#mode'), /READ-ONLY/);
    await page.click('nav a[href="#issues"]');
    await page.waitForSelector('.ev img');
    await page.waitForFunction(() => { const i = document.querySelector('.ev img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
    assert.strictEqual(await page.locator('.ev video').count(), 0);
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});
