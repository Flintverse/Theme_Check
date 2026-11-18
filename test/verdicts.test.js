// Manual verdicts (Skip / Pass / Review / Fail on top of the script's result), the picture X button, the responsive drawer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const checklist = require('../checklist/checklist.json');
const { finalizeRun, refreshRun } = require('../src/store/archive');
const ovr = require('../src/store/overrides');
const { render } = require('../src/report/html');
const { listen } = require('../src/server');

const SRC = path.resolve(__dirname, '..');
const run = (runId, date, spec) => ({
  runId, env: 'staging', shop: 's', startedAt: `${date}T07:30:00.000Z`,
  themes: Object.entries(spec).map(([name, results]) => ({ name, passes: [{ layout: 'vertical', viewport: 'desktop', results: results.map(([id, status, detail]) => ({ id, layout: 'vertical', status, detail: detail || '', shots: status === 'fail' ? [`${name.toLowerCase()}/${id}.png`] : [] })) }] })),
});
const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

test('verdict document: a change gets a higher rev, the script result is never touched, skip counts as not testable', () => {
  const d0 = ovr.empty();
  const d1 = ovr.withVerdict(d0, 'Dawn|vertical|desktop|V-10', 'pass', 'fail', 'Dung', 1000);
  assert.strictEqual(d1.items['Dawn|vertical|desktop|V-10'].status, 'pass');
  assert.strictEqual(d1.items['Dawn|vertical|desktop|V-10'].orig, 'fail');
  const d2 = ovr.withVerdict(d1, 'Dawn|vertical|desktop|V-10', null, '', 'Dung', 500); // an older clock still goes up
  assert.ok(d2.rev > d1.rev);
  assert.deepStrictEqual(d2.items, {});
  assert.strictEqual(ovr.validKey('Dawn|vertical|desktop|V-10'), true);
  ['', 'a|b|c', 'a|b|c|d|e', 'a|b|c|<d>', 'x'.repeat(300) + '|a|b|c'].forEach((k) => assert.strictEqual(ovr.validKey(k), false, k));
  const r = run('r', '2026-11-18', { Dawn: [['V-10', 'fail', 'x'], ['V-03', 'pass'], ['V-06', 'na']] });
  const eff = ovr.applyOverrides(r, { items: { 'Dawn|vertical|desktop|V-10': { status: 'skip' }, 'Dawn|vertical|desktop|V-03': { status: 'fail' } } });
  const res = eff.themes[0].passes[0].results;
  assert.deepStrictEqual(res.map((x) => x.status), ['na', 'fail', 'na']);
  assert.strictEqual(res[0].manual, 'skip');
  assert.strictEqual(res[0].autoStatus, 'fail');
  assert.strictEqual(r.themes[0].passes[0].results[0].status, 'fail', 'the original run object is untouched');
  assert.strictEqual(ovr.applyOverrides(r, { items: {} }), r);
});

test('report page: manual badge, and a picture pop-up with an X that needs no script', () => {
  const r = run('r', '2026-11-18', { Dawn: [['V-10', 'fail', 'x']] });
  const html = render(ovr.applyOverrides(r, { items: { 'Dawn|vertical|desktop|V-10': { status: 'pass', by: 'Dung' } } }), checklist, null);
  assert.match(html, /MANUAL PASS \(script: fail\)/);
  const plain = render(r, checklist, null);
  assert.match(plain, /class="lb" id="pic\d+"/);
  assert.match(plain, /class="x" href="#closed"/);
  assert.match(plain, /\.lb:target\{display:flex\}/);
  assert.ok(!/<script/i.test(plain), 'the report may not need scripts (its Content-Security-Policy forbids them)');
});

test('local dashboard: a verdict recalculates the report, the numbers, the run index and the issue tracker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vd-'));
  ['config', 'checklist', 'ui'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  fs.rmSync(path.join(root, 'config', 'config.local.json'), { force: true });
  const runs = [run('2026-11-11-staging', '2026-11-11', { Craft: [['V-10', 'fail', 'no tick'], ['V-06', 'fail', 'circle']] }), run('2026-11-18-staging', '2026-11-18', { Craft: [['V-10', 'fail', 'no tick'], ['V-06', 'pass']], Dawn: [['V-10', 'fail', 'x']] })];
  runs.forEach((r) => { fs.mkdirSync(path.join(root, 'history', 'runs', r.runId), { recursive: true }); fs.writeFileSync(path.join(root, 'history', 'runs', r.runId, 'results.json'), JSON.stringify(r)); finalizeRun({ root, cfg: { archive: {} }, run: r, checklist, trackIssues: true }); });
  const server = await listen(root, 0, { spawnRun: false, propagate: async () => [] });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (b) => fetch(base + '/api/overrides', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-TC': '1' }, body: JSON.stringify(b) });
  const rd = (...p) => JSON.parse(fs.readFileSync(path.join(root, 'history', ...p), 'utf8'));
  try {
    assert.strictEqual(rd('runs', '2026-11-18-staging', 'summary.json').failedChecks, 2);
    assert.strictEqual(rd('data', 'issues.json').items['staging|Dawn|vertical|V-10'].status, 'open');
    const key = 'Dawn|vertical|desktop|V-10';
    // refused
    assert.strictEqual((await put({ run: '../x', key, status: 'pass' })).status, 400);
    assert.strictEqual((await put({ run: '2026-11-18-staging', key: 'bad', status: 'pass' })).status, 400);
    assert.strictEqual((await put({ run: '2026-11-18-staging', key, status: 'maybe' })).status, 400);
    assert.strictEqual((await put({ run: 'nope', key, status: 'pass' })).status, 404);
    assert.strictEqual((await fetch(base + '/api/overrides', { method: 'PUT', body: '{}' })).status, 403, 'the safety header is required');
    // the person decides Dawn V-10 is fine
    const ok = await put({ run: '2026-11-18-staging', key, status: 'pass', orig: 'fail' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(rd('runs', '2026-11-18-staging', 'results.json').themes[1].passes[0].results[0].status, 'fail', 'the script result is kept');
    assert.strictEqual(rd('runs', '2026-11-18-staging', 'summary.json').failedChecks, 1);
    assert.strictEqual(rd('data', 'runs.json').find((r) => r.runId === '2026-11-18-staging').failedChecks, 1);
    assert.match(fs.readFileSync(path.join(root, 'history', 'runs', '2026-11-18-staging', 'report.html'), 'utf8'), /MANUAL PASS/);
    assert.strictEqual(rd('data', 'issues.json').items['staging|Dawn|vertical|V-10'], undefined, 'it never counted as an issue');
    // a pass turns out to be a fail by hand: Craft V-06 was fixed by the script, the person says it is not
    await put({ run: '2026-11-18-staging', key: 'Craft|vertical|desktop|V-06', status: 'fail', orig: 'pass' });
    assert.strictEqual(rd('runs', '2026-11-18-staging', 'summary.json').failedChecks, 2);
    assert.strictEqual(rd('data', 'issues.json').items['staging|Craft|vertical|V-06'].status, 'open', 'the tracker follows the verdict');
    // untick: back to the script's result
    await put({ run: '2026-11-18-staging', key: 'Craft|vertical|desktop|V-06', status: null });
    await put({ run: '2026-11-18-staging', key, status: null });
    assert.strictEqual(rd('runs', '2026-11-18-staging', 'summary.json').failedChecks, 2);
    assert.strictEqual(rd('data', 'issues.json').items['staging|Craft|vertical|V-06'].status, 'fixed');
    assert.deepStrictEqual(rd('runs', '2026-11-18-staging', 'overrides.json').items, {});
    assert.strictEqual(refreshRun({ root, cfg: { archive: {} }, runId: 'nope', checklist }).ok, false);
  } finally { server.close(); }
});

test('Cloudflare: only editors can put a verdict; the test machine can fetch it', async () => {
  const lib = await imp('cf/lib.js');
  const store = new Map();
  const R2 = { async put(k, b) { store.set(k, typeof b === 'string' ? b : String(b)); }, async get(k) { return store.has(k) ? { body: store.get(k), text: async () => store.get(k) } : null; }, async delete(k) { store.delete(k); } };
  const env = { STORE: R2, SESSION_SECRET: 's'.repeat(40), ALLOWED_DOMAIN: 'bsscommerce.com', EDITORS: 'dungnn@bsscommerce.com', INGEST_TOKEN: 'ingest-token-1234567' };
  store.set('runs/r1/results.json', '{}');
  const cookie = async (email) => 'tc_session=' + (await lib.makeSession(env, { email, name: '' }));
  const fn = await imp('functions/api/overrides.js');
  const ingest = await imp('functions/api/ingest/[[path]].js');
  const put = (c, b) => fn.onRequestPut({ request: new Request('https://x.dev/api/overrides', { method: 'PUT', headers: c ? { cookie: c } : {}, body: JSON.stringify(b) }), env });
  const key = 'Dawn|vertical|desktop|V-10';
  assert.strictEqual((await put(null, { run: 'r1', key, status: 'pass' })).status, 403);
  assert.strictEqual((await put(await cookie('other@bsscommerce.com'), { run: 'r1', key, status: 'pass' })).status, 403);
  const ed = await cookie('dungnn@bsscommerce.com');
  assert.strictEqual((await put(ed, { run: '../x', key, status: 'pass' })).status, 400);
  assert.strictEqual((await put(ed, { run: 'r1', key: 'a|b', status: 'pass' })).status, 400);
  assert.strictEqual((await put(ed, { run: 'r1', key, status: 'ok' })).status, 400);
  assert.strictEqual((await put(ed, { run: 'r2', key, status: 'pass' })).status, 404);
  const a = await (await put(ed, { run: 'r1', key, status: 'pass', orig: 'fail' })).json();
  assert.strictEqual(a.items[key].by, 'dungnn@bsscommerce.com');
  const b = await (await put(ed, { run: 'r1', key: 'Dawn|vertical|desktop|V-03', status: 'skip', orig: 'na' })).json();
  assert.ok(b.rev > a.rev);
  assert.strictEqual(Object.keys(b.items).length, 2, 'two verdicts are kept side by side');
  const c = await (await put(ed, { run: 'r1', key, status: null })).json();
  assert.deepStrictEqual(Object.keys(c.items), ['Dawn|vertical|desktop|V-03']);
  const get = (auth, q) => ingest.onRequestGet({ request: new Request('https://x.dev/api/ingest/overrides' + q, { headers: auth ? { authorization: 'Bearer ' + env.INGEST_TOKEN } : {} }), env, params: { path: ['overrides'] } });
  assert.strictEqual((await get(false, '?run=r1')).status, 401);
  assert.strictEqual((await get(true, '?run=..%2Fx')).status, 400);
  assert.strictEqual((await (await get(true, '?run=r1')).json()).rev, c.rev);
  assert.deepStrictEqual(await (await get(true, '?run=zzz')).json(), { rev: 0, items: {} });
});

test('agent: a newer web copy is applied here, a newer local copy is sent up, an equal one is left alone', async () => {
  const agent = require('../src/agent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ag-'));
  ['config', 'checklist'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  const rdir = path.join(root, 'history', 'runs', '2026-11-18-staging');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'results.json'), JSON.stringify(run('2026-11-18-staging', '2026-11-18', { Dawn: [['V-10', 'fail', 'x']] })));
  fs.writeFileSync(path.join(rdir, 'report.html'), '<html></html>');
  const cfg = { envs: { staging: {} }, cloudflare: { url: 'https://x.dev' } };
  const old = process.env.THEME_CHECK_TOKEN; process.env.THEME_CHECK_TOKEN = 'tok-tok-tok-tok-1234';
  const sent = [];
  let remote = { rev: 0, items: {} };
  const fetchImpl = async (url, init) => { if (!init || !init.method) return { ok: true, json: async () => remote }; sent.push(url.split('/api/ingest/')[1]); return { ok: true }; };
  let refreshed = 0;
  const opts = { fetchImpl, refresh: () => { refreshed++; return { ok: true }; }, pushState: async () => { sent.push('state'); } };
  try {
    assert.deepStrictEqual(await agent.syncOverrides(root, cfg, opts), { changed: 0 }, 'nothing on either side');
    remote = { rev: 5000, items: { 'Dawn|vertical|desktop|V-10': { status: 'pass', orig: 'fail', by: 'dungnn@bsscommerce.com' } } };
    assert.strictEqual((await agent.syncOverrides(root, cfg, opts)).changed, 1);
    assert.strictEqual(ovr.readOverrides(rdir).rev, 5000);
    assert.strictEqual(refreshed, 1);
    assert.ok(sent.some((s) => s.endsWith('overrides.json')) && sent.includes('state'), 'numbers go back up to the web page');
    sent.length = 0;
    assert.strictEqual((await agent.syncOverrides(root, cfg, opts)).changed, 0, 'same rev: nothing to do');
    ovr.writeOverrides(rdir, { rev: 9000, items: { 'Dawn|vertical|desktop|V-10': { status: 'skip', orig: 'fail', by: 'local' } } });
    assert.strictEqual((await agent.syncOverrides(root, cfg, opts)).changed, 1);
    assert.ok(sent.some((s) => /media\/2026-11-18-staging\/overrides\.json$/.test(s)), 'the newer local copy goes up');
    assert.strictEqual(refreshed, 2);
  } finally { if (old === undefined) delete process.env.THEME_CHECK_TOKEN; else process.env.THEME_CHECK_TOKEN = old; }
});

// ---------------- the page
function stub(opts) {
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const rows = [];
  for (let i = 1; i <= 14; i++) rows.push({ id: 'V-' + String(i).padStart(2, '0'), layout: 'vertical', status: i <= 3 ? 'fail' : i === 4 ? 'review' : i === 5 ? 'na' : 'pass', detail: 'row ' + i, shots: i <= 3 ? ['dawn/vertical-desktop/V-0' + i + '.png'] : [] });
  const results = { runId: 'r1', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', results: rows }, { layout: 'horizontal', viewport: 'desktop', results: rows.map((r) => Object.assign({}, r, { layout: 'horizontal' })) }] }] };
  const base = { readOnly: true, mediaLocal: true, envs: ['staging'], themes: [], schedule: { description: 'x' }, runs: [], issues: { items: {} }, themeStatus: [], checklist: rows.map((r) => ({ id: r.id, title: 'Title of ' + r.id, severity: 'minor' })), library: {} };
  const prog = { running: true, runId: 'r1', env: 'staging', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: 'testing', mode: 'background', totals: { pass: 18, fail: 6, na: 2, review: 2 }, current: null,
    themes: [{ name: 'Dawn', batch: 1, status: 'done', step: 'finished', fail: 6, pass: 18, review: 2, activeMs: 5000, activeSince: null }], events: [] };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const state = { items: {}, rev: 0, puts: [] };
  const srv = http.createServer((req, res) => {
    const send = (o, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(base);
    if (req.url === '/api/progress') return send(prog);
    if (req.url === '/api/me') return send({ email: 'dungnn@bsscommerce.com', canEdit: opts.canEdit });
    if (req.url === '/runs/r1/results.json') return send(results);
    if (req.url === '/runs/r1/overrides.json') return send({ rev: state.rev, items: state.items });
    if (req.url.startsWith('/runs/r1/dawn')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
    if (req.url === '/api/overrides' && req.method === 'PUT') {
      let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
        const j = JSON.parse(b); state.puts.push(j);
        if (opts.failSave) return send({ error: 'nope' }, 500);
        if (j.status) state.items[j.key] = { status: j.status, orig: j.orig, by: 'dungnn@bsscommerce.com' }; else delete state.items[j.key];
        state.rev += 1; send({ ok: true, rev: state.rev, items: state.items });
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  return { srv, state };
}
const listenOn = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const kpiOf = (page, label) => page.evaluate((l) => { const k = Array.from(document.querySelectorAll('#detail-body .kpi')).find((x) => x.querySelector('span').textContent === l); return k ? Number(k.querySelector('b').textContent) : null; }, label);
const liveKpi = (page, label) => page.evaluate((l) => { const k = Array.from(document.querySelectorAll('main .kpi')).find((x) => x.querySelector('span').textContent === l); return k ? Number(k.querySelector('b').textContent) : null; }, label);

test('the page: tick a verdict, numbers follow (drawer and Live), untick goes back; a picture has an X; the drawer is not squeezed', async () => {
  const { srv, state } = stub({ canEdit: true });
  await listenOn(srv);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.address().port}/#live`);
    await page.waitForSelector('button[data-theme="Dawn"]');
    assert.strictEqual(await liveKpi(page, 'Failed so far'), 6);
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on .chk');

    // 1. real size and scrollable: nothing is squeezed, the drawer scrolls down
    const lay = await page.evaluate(() => {
      const p = document.getElementById('detail-body');
      const cards = Array.from(p.querySelectorAll('.card')).map((c) => ({ h: c.getBoundingClientRect().height, sh: c.scrollHeight }));
      const kp = p.querySelector('.kpis').getBoundingClientRect().height;
      return { scrollable: p.scrollHeight > p.clientHeight + 50, cards, kp, rowsMin: Math.min.apply(null, Array.from(p.querySelectorAll('.chk tbody tr')).map((r) => r.getBoundingClientRect().height)) };
    });
    assert.ok(lay.scrollable, 'the drawer is taller than the screen and scrolls');
    lay.cards.forEach((c) => assert.ok(c.h >= c.sh - 2, 'a card is not squeezed: ' + c.h + ' vs ' + c.sh));
    assert.ok(lay.kp >= 40, 'the numbers keep their height: ' + lay.kp);
    assert.ok(lay.rowsMin >= 30, 'table rows keep their height: ' + lay.rowsMin);
    await page.evaluate(() => { document.getElementById('detail-body').scrollTop = 600; });
    assert.ok((await page.evaluate(() => document.getElementById('detail-body').scrollTop)) > 100, 'it scrolled down');

    // 2. picture: X button
    await page.evaluate(() => { document.getElementById('detail-body').scrollTop = 0; });
    await page.click('#detail-body img[data-zoom] >> nth=0');
    await page.waitForSelector('#lightbox .lb-x');
    assert.strictEqual(await page.isVisible('#lightbox .lb-x'), true);
    await page.click('#lightbox .lb-x');
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('lightbox')).display), 'none');
    assert.strictEqual(await page.locator('#detail.on').count(), 1, 'the drawer is still open');

    // 3. verdicts
    assert.strictEqual(await kpiOf(page, 'Failed'), 6);
    const box = (id, v, pass) => page.locator('input[data-vk="Dawn|' + (pass || 'vertical') + '|desktop|' + id + '"]' + (v ? '[data-v="' + v + '"]' : ''));
    assert.strictEqual(await box('V-01').count(), 4, 'Skip, Pass, Review, Fail');
    assert.deepStrictEqual(await page.locator('#detail-body .vb').evaluateAll((a) => a.slice(0, 4).map((x) => x.textContent.trim())), ['Skip', 'Pass', 'Review', 'Fail']);
    await box('V-01', 'pass').check();
    await page.waitForFunction(() => /Saved/.test(document.getElementById('detail-body').textContent));
    assert.deepStrictEqual(state.puts[0], { run: 'r1', key: 'Dawn|vertical|desktop|V-01', status: 'pass', orig: 'fail' });
    assert.strictEqual(await kpiOf(page, 'Failed'), 5, 'one fewer failed');
    assert.strictEqual(await kpiOf(page, 'Passed'), 19);
    // the row stays visible with its new state and the script's answer
    assert.match(await page.textContent('#detail-body'), /script said: FAIL/);
    // Skip on a review row
    await box('V-04', 'skip').check();
    await page.waitForTimeout(400);
    assert.strictEqual(await kpiOf(page, 'To review'), 1);
    assert.strictEqual(await kpiOf(page, 'Skipped by hand'), 1);
    // Fail on a passed row (needs "show passed")
    await page.check('#d-all');
    await box('V-09', 'fail').check();
    await page.waitForTimeout(400);
    assert.strictEqual(await kpiOf(page, 'Failed'), 6);
    assert.strictEqual(await kpiOf(page, 'Passed'), 18);
    // only one box per row: ticking Review on the first row unticks Pass
    await box('V-01', 'review').check();
    await page.waitForTimeout(400);
    assert.deepStrictEqual(await box('V-01').evaluateAll((a) => a.filter((x) => x.checked).map((x) => x.getAttribute('data-v'))), ['review']);
    // Live numbers behind the drawer follow too
    await page.press('body', 'Escape');
    await page.waitForTimeout(3500);
    const live = { fail: await liveKpi(page, 'Failed so far'), pass: await liveKpi(page, 'Passed so far'), review: await liveKpi(page, 'To review'), skip: await liveKpi(page, 'Skipped by hand') };
    // script: fail 6, pass 18, review 2, na 2. by hand: V-01 review, V-04 skip, V-09 fail => fail 6-1+1=6, pass 18-1=17, review 2-1+1=2, skip 1
    assert.deepStrictEqual(live, { fail: 6, pass: 17, review: 2, skip: 1 });
    assert.match(await page.textContent('main'), /3 set by hand/);
    // untick: back to what the script found
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on .chk');
    await box('V-01', 'review').uncheck();
    await page.waitForTimeout(400);
    assert.strictEqual(state.puts[state.puts.length - 1].status, null);
    assert.strictEqual(await kpiOf(page, 'Failed'), 7, 'V-01 is a script FAIL again, V-09 fails by hand');
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});

test('the page: a person who is not an editor sees the boxes but cannot tick them; a failed save is put back', async () => {
  let s = stub({ canEdit: false });
  await listenOn(s.srv);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`http://127.0.0.1:${s.srv.address().port}/#live`);
    await page.waitForSelector('button[data-theme="Dawn"]');
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on .chk');
    assert.strictEqual(await page.locator('#detail-body input[data-vk]:not([disabled])').count(), 0);
    assert.match(await page.textContent('#detail-body'), /Only the editors can change a result/);
    await page.close();
  } finally { s.srv.close(); }
  s = stub({ canEdit: true, failSave: true });
  await listenOn(s.srv);
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`http://127.0.0.1:${s.srv.address().port}/#live`);
    await page.waitForSelector('button[data-theme="Dawn"]');
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on .chk');
    await page.locator('input[data-vk="Dawn|vertical|desktop|V-01"][data-v="pass"]').click();
    await page.waitForFunction(() => /Could not save/.test(document.getElementById('detail-body').textContent));
    assert.strictEqual(await kpiOf(page, 'Failed'), 6, 'back to what it was');
    assert.strictEqual(await page.locator('#detail-body input[data-v="pass"]:checked').count(), 0);
    await page.close();
  } finally { s.srv.close(); await browser.close(); }
});
