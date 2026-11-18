// The local dashboard: API behaviour, safety rules, and the page itself rendered in Chrome with seeded history.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const checklist = require('../checklist/checklist.json');
const { finalizeRun } = require('../src/store/archive');
const { listen } = require('../src/server');

const SRC = path.resolve(__dirname, '..');
const mk = (runId, date, spec) => ({
  runId, env: 'staging', shop: 's', startedAt: `${date}T07:30:00.000Z`,
  themes: Object.entries(spec).map(([name, results]) => ({ name, passes: [{ layout: 'vertical', viewport: 'desktop', video: null, results: results.map(([id, status, detail]) => ({ id, layout: 'vertical', status, detail: detail || '', shots: [] })) }] })),
});

let root, server, base, browser;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ui-'));
  ['config', 'checklist', 'ui'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  const cfg = { archive: {} };
  [mk('2026-11-11-staging', '2026-11-11', { Dawn: [['V-10', 'fail', 'no tick <script>alert(1)</script>'], ['V-03', 'pass']], Craft: [['V-10', 'fail', 'no tick'], ['V-06', 'fail', 'circle only']], Rise: [['V-10', 'pass']] }),
    mk('2026-11-18-staging', '2026-11-18', { Dawn: [['V-10', 'pass'], ['V-03', 'pass']], Craft: [['V-10', 'fail', 'no tick'], ['V-06', 'pass']], Rise: [['V-10', 'fail', 'no tick']] })]
    .forEach((run) => { fs.mkdirSync(path.join(root, 'history', 'runs', run.runId), { recursive: true }); fs.writeFileSync(path.join(root, 'history', 'runs', run.runId, 'results.json'), JSON.stringify(run)); finalizeRun({ root, cfg, run, checklist, trackIssues: true }); });
  server = await listen(root, 0, { spawnRun: false });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
test.after(async () => { await browser.close(); server.close(); });

const call = (method, p, body, headers) => fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined });
const H = { 'X-TC': '1' };

test('state returns themes, runs, issues and the checklist', async () => {
  const s = await (await call('GET', '/api/state')).json();
  assert.strictEqual(s.runs.length, 2);
  assert.strictEqual(s.runs[0].date, '2026-11-18');
  assert.ok(s.themes.length >= 58);
  assert.ok(s.envs.includes('staging'));
  assert.ok(Object.keys(s.issues.items).length >= 3);
});

test('changing settings needs our header; a foreign origin is refused', async () => {
  assert.strictEqual((await call('PUT', '/api/themes', { themes: [] })).status, 403);
  assert.strictEqual((await call('PUT', '/api/themes', { themes: [] }, Object.assign({ Origin: 'https://evil.example' }, H))).status, 403);
});

test('themes: add, remove, auto-batch are saved to config/themes.json', async () => {
  const s = await (await call('GET', '/api/state')).json();
  const next = s.themes.concat([{ name: 'Brand New Theme', batch: 9, enabled: true }, { name: 'dawn', batch: 1 }]).filter((t) => t.name !== 'Pebble');
  const r = await (await call('PUT', '/api/themes', { themes: next, autoBatch: 10 }, H)).json();
  assert.ok(r.themes.some((t) => t.name === 'Brand New Theme'));
  assert.ok(!r.themes.some((t) => t.name === 'Pebble'));
  assert.strictEqual(r.themes.filter((t) => t.name.toLowerCase() === 'dawn').length, 1, 'duplicate dropped');
  assert.strictEqual(Math.max(...r.themes.map((t) => t.batch)), Math.ceil(r.themes.length / 10));
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config', 'themes.json'), 'utf8'));
  assert.strictEqual(onDisk.themes.length, r.themes.length);
  assert.strictEqual((await call('PUT', '/api/themes', { themes: 'x' }, H)).status, 400);
});

test('schedule: saved when valid, refused when not', async () => {
  const ok = await call('PUT', '/api/schedule', { enabled: true, mode: 'everyNDays', everyDays: 3, time: '06:45', env: 'staging', batches: 'all', mail: true }, H);
  assert.strictEqual(ok.status, 200);
  const j = await ok.json();
  assert.match(j.description, /Every 3 days at 06:45/);
  assert.ok(fs.existsSync(path.join(root, 'config', 'schedule.json')));
  assert.strictEqual((await call('PUT', '/api/schedule', { enabled: true, mode: 'daily', time: '25:99', env: 'staging' }, H)).status, 400);
  assert.strictEqual((await call('PUT', '/api/schedule', { enabled: true, mode: 'daily', time: '07:00', env: 'staging', batches: '1;rm' }, H)).status, 400);
});

test('run now: validated, and only the CLI run command is built (no spawn in tests)', async () => {
  const r = await (await call('POST', '/api/run', { env: 'staging', batches: '1,2', mail: true }, H)).json();
  assert.strictEqual(r.dry, true);
  assert.deepStrictEqual(r.args.slice(1), ['run', '--env', 'staging', '--batches', '1,2', '--mail']);
  assert.strictEqual((await call('POST', '/api/run', { env: 'nope' }, H)).status, 409);
  assert.strictEqual((await call('POST', '/api/run', { env: 'staging', batches: '1 && calc' }, H)).status, 409);
});

test('files: reports are served, path traversal is not', async () => {
  const ok = await fetch(`${base}/runs/2026-11-18-staging/report.html`);
  assert.strictEqual(ok.status, 200);
  assert.match(await ok.text(), /Theme compatibility run/);
  const bad = await fetch(`${base}/runs/..%2F..%2Fconfig%2Fconfig.example.json`);
  assert.ok([403, 404].includes(bad.status));
  const bad2 = await fetch(`${base}/..%2Fpackage.json`);
  assert.ok([403, 404].includes(bad2.status));
});

test('the page renders every tab, escapes issue text, and the add-theme flow works', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const go = async (tab, title) => { await page.click(`nav a[href="#${tab}"]`); await page.waitForFunction((x) => document.querySelector('main h2') && document.querySelector('main h2').textContent.indexOf(x) === 0, title); };
  await page.goto(base);
  await page.waitForSelector('.kpis');
  assert.match(await page.textContent('#mode'), /LOCAL/);
  assert.match(await page.textContent('main'), /Latest run: 2026-11-18/);
  assert.match(await page.textContent('main'), /Themes with the most failing checks/);
  await page.screenshot({ path: path.join(SRC, 'test', '_ui-overview.png'), fullPage: true });
  await go('issues', 'Issue tracker');
  await page.selectOption('#f-status', '');
  const txt = await page.textContent('main');
  assert.match(txt, /<script>alert\(1\)<\/script>/, 'shown as text, not executed');
  assert.strictEqual(await page.locator('main script').count(), 0);
  assert.match(txt, /Fixed on/);
  assert.match(txt, /2026-11-18/);
  await page.screenshot({ path: path.join(SRC, 'test', '_ui-issues.png'), fullPage: true });
  await go('runs', 'Runs');
  assert.match(await page.textContent('main'), /2026-11-11-staging/);
  await go('themes', 'Themes');
  await page.fill('#t-new', 'Impulse Test');
  await page.click('#t-add');
  assert.match(await page.textContent('main'), /Unsaved changes/);
  await page.click('#t-save');
  await page.waitForFunction(() => document.querySelector('#t-msg') && /Saved/.test(document.querySelector('#t-msg').textContent));
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config', 'themes.json'), 'utf8')).themes;
  assert.ok(saved.some((t) => t.name === 'Impulse Test'));
  await page.screenshot({ path: path.join(SRC, 'test', '_ui-themes.png') });
  await go('schedule', 'Schedule');
  await page.selectOption('#s-mode', 'weekly');
  assert.ok(await page.isVisible('#w-day'));
  assert.ok(!(await page.isVisible('#w-n')));
  await page.selectOption('#s-mode', 'everyNDays');
  assert.ok(await page.isVisible('#w-n'));
  await page.screenshot({ path: path.join(SRC, 'test', '_ui-schedule.png') });
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test('publish: a read-only copy works on a plain static host', async () => {
  const http = require('http');
  const { publish } = require('../src/publish');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.example.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'history', 'runs', '2026-11-18-staging', 'x.webm'), 'v');
  const r = publish(root, cfg, 'site', {});
  assert.strictEqual(r.runs, 2);
  assert.ok(!fs.existsSync(path.join(root, 'site', 'runs', '2026-11-18-staging', 'x.webm')), 'videos left out by default');
  assert.ok(fs.existsSync(path.join(root, 'site', 'runs', '2026-11-18-staging', 'report.html')));
  const site = path.join(root, 'site');
  const mime = { '.html': 'text/html', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const f = path.join(site, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(site) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForSelector('.kpis');
  assert.match(await page.textContent('#mode'), /READ-ONLY COPY/);
  await page.click('nav a[href="#themes"]');
  await page.waitForSelector('#t-add');
  assert.ok(await page.isDisabled('#t-add'));
  assert.ok(await page.isDisabled('#t-save'));
  await page.click('nav a[href="#schedule"]');
  await page.waitForSelector('#s-save');
  assert.ok(await page.isDisabled('#s-save'));
  await page.close();
  srv.close();
});
