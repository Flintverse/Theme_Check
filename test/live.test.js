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
  assert.strictEqual(c.everyMs, 90000, 'progress is sent about every 90 s by default (free KV allows ~1000 writes a day)');
  assert.strictEqual(sync.syncConfig({ cloudflare: { url: 'https://a.pages.dev', progressEverySeconds: 5 } }, { THEME_CHECK_TOKEN: 'tok' }).everyMs, 30000, 'never faster than 30 s');
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

test('push: a daily budget protects the free KV write limit; the final update always goes out', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push(JSON.parse(init.body).n); return { ok: true }; };
  let now = Date.parse('2026-11-18T01:00:00Z');
  const push = sync.createProgressPusher({ base: 'https://x.dev', headers: {} }, { everyMs: 1000, maxPerDay: 3, fetchImpl: f, now: () => now });
  for (let i = 1; i <= 6; i++) { now += 2000; push({ running: true, n: i }); }
  push({ running: false, n: 99 });
  await push.done();
  assert.deepStrictEqual(calls, [1, 2, 3, 99], 'three updates, then only the final one');
  now = Date.parse('2026-11-19T01:00:00Z'); // the next day the budget starts again
  push({ running: true, n: 100 });
  await push.done();
  assert.strictEqual(calls[calls.length - 1], 100);
});

// ---- Cloudflare Functions against a fake KV namespace
function fakeKV() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, String(v)); }, async get(k) { return m.has(k) ? m.get(k) : null; } };
}
const TOKEN = 'a-long-test-token-1234567890';
const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

test('cloudflare ingest: refuses without the token, stores progress and state, serves them back', async () => {
  const env = { STORE: fakeKV(), INGEST_TOKEN: TOKEN };
  const ingest = await imp('functions/api/ingest/[[path]].js');
  const req = (method, body, auth) => new Request('https://x.dev/api/ingest/x', { method, body, headers: auth === false ? {} : { authorization: 'Bearer ' + (auth || TOKEN) } });
  const call = (p, body, auth, e) => ingest.onRequestPost({ request: req('POST', body, auth), env: e || env, params: { path: [p] } });
  assert.strictEqual((await call('ping', '{}', false)).status, 401);
  assert.strictEqual((await call('ping', '{}', 'wrong-token-wrong-token-1')).status, 401);
  assert.strictEqual((await call('ping', '{}', undefined, { STORE: env.STORE })).status, 401, 'no secret configured means nobody gets in');
  assert.strictEqual((await call('ping', '{}')).status, 200);
  assert.strictEqual((await call('progress', 'not json')).status, 400);
  assert.strictEqual((await call('progress', JSON.stringify({ running: true, runId: 'r' }))).status, 200);
  assert.strictEqual((await call('state', JSON.stringify({ runs: [{ runId: 'r' }] }))).status, 200);
  assert.strictEqual((await call('media', 'x')).status, 404, 'there is no media upload: pictures stay off Cloudflare');
  assert.ok(env.STORE.m.has('state') && env.STORE.m.has('progress'));
  assert.deepStrictEqual([...env.STORE.m.keys()].sort(), ['progress', 'state'], 'only two keys are ever written');

  const state = await imp('functions/api/state.js');
  const get = (fn, e, key) => fn.onRequestGet({ request: new Request('https://x.dev/api/x', { headers: key ? { 'x-access-key': key } : {} }), env: e });
  assert.deepStrictEqual((await (await get(state, env)).json()).runs, [{ runId: 'r' }]);
  const empty = await (await get(state, { STORE: fakeKV() })).json();
  assert.strictEqual(empty.readOnly, true, 'empty state before the first push');
  assert.strictEqual(empty.mediaLocal, false);

  const progress = await imp('functions/api/progress.js');
  assert.strictEqual((await (await get(progress, env)).json()).running, true);
  env.STORE.m.set('progress', JSON.stringify({ running: true, updatedAt: new Date(Date.now() - 11 * 60000).toISOString() }));
  const stale = await (await get(progress, env)).json();
  assert.strictEqual(stale.running, false);
  assert.strictEqual(stale.phase, 'stalled');
});

test('cloudflare reading: with READ_KEY set, the team access code is required', async () => {
  const env = { STORE: fakeKV(), READ_KEY: 'team-code-1234' };
  await env.STORE.put('state', JSON.stringify({ runs: [{ runId: 'secret-run' }] }));
  const state = await imp('functions/api/state.js');
  const progress = await imp('functions/api/progress.js');
  const get = (fn, key) => fn.onRequestGet({ request: new Request('https://x.dev/api/x', { headers: key ? { 'x-access-key': key } : {} }), env });
  assert.strictEqual((await get(state)).status, 401);
  assert.strictEqual((await get(state, 'wrong-code-9999')).status, 401);
  assert.strictEqual((await get(progress)).status, 401);
  const ok = await get(state, 'team-code-1234');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).runs[0].runId, 'secret-run');
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

test('the Cloudflare copy asks for the team access code, then points to Drive instead of inline media', async () => {
  const http = require('http');
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const state = { readOnly: true, mediaLocal: false, evidenceUrl: 'https://drive.example/folder', envs: ['staging'], themes: [], schedule: { description: 'x' }, runs: [{ runId: '2026-11-18-staging', env: 'staging', date: '2026-11-18', startedAt: '2026-11-18T01:00:00Z', themesTotal: 1, themesTested: 1, themesWithIssues: 1, failedChecks: 1, newCount: 1, fixedCount: 0, worstThemes: [{ theme: 'Dawn', fails: 1 }], topChecks: [{ id: 'V-10', title: 'Selected looks selected', severity: 'critical', themes: 1 }], fixed: [], setupFailures: [] }], issues: { items: { 'staging|Dawn|vertical|V-10': { env: 'staging', theme: 'Dawn', layout: 'vertical', id: 'V-10', title: 'Selected looks selected', severity: 'critical', status: 'open', firstSeen: '2026-11-18', lastSeen: '2026-11-18', lastRun: '2026-11-18-staging', history: [{ s: 'fail', date: '2026-11-18' }], evidence: { run: '2026-11-18-staging', shots: ['dawn/a.png'], video: 'dawn/video.webm' } } } }, themeStatus: [], checklist: [], library: {} };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/state') || req.url.startsWith('/api/progress')) {
      if (req.headers['x-access-key'] !== 'team-code-1234') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"access code needed"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(req.url.startsWith('/api/progress') ? '{"running":false,"none":true}' : JSON.stringify(state));
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
    assert.ok(!(await page.textContent('main')).includes('secret'), 'no data before the code');
    await page.fill('#k-in', 'wrong-code-9999');
    await page.click('#k-go');
    await page.waitForFunction(() => /not accepted/.test(document.querySelector('main').textContent));
    await page.fill('#k-in', 'team-code-1234');
    await page.click('#k-go');
    await page.waitForSelector('.kpis');
    assert.match(await page.textContent('#mode'), /READ-ONLY/);
    await page.click('nav a[href="#issues"]');
    await page.waitForFunction(() => /Open the evidence on Drive/.test(document.querySelector('main').textContent));
    assert.strictEqual(await page.locator('.ev img, .ev video').count(), 0, 'no inline media on the Cloudflare copy');
    assert.match(await page.textContent('main'), /runs\/2026-11-18-staging\/dawn\/a\.png/);
    assert.strictEqual(await page.getAttribute('a[href="https://drive.example/folder"]', 'target'), '_blank');
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});
