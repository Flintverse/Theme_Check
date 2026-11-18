// Navigation: a way back and a way to every other page, from every page (dashboard tabs, the theme drawer, the full report).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');
const checklist = require('../checklist/checklist.json');
const { finalizeRun } = require('../src/store/archive');
const { render } = require('../src/report/html');
const { listen } = require('../src/server');

const SRC = path.resolve(__dirname, '..');
const TABS = ['live', 'overview', 'issues', 'runs', 'themes', 'schedule'];

function stub() {
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const item = { env: 'staging', theme: 'Dawn', layout: 'vertical', id: 'V-10', title: 'Tick', severity: 'minor', status: 'open', firstSeen: '2026-11-18', firstRun: 'r1', lastSeen: '2026-11-18', lastRun: 'r1', fixedOn: null, reopened: 0, lastDetail: 'x', history: [{ run: 'r1', date: '2026-11-18', s: 'fail' }] };
  const base = { readOnly: true, mediaLocal: true, envs: ['staging'], themes: [{ name: 'Dawn', envs: ['staging'], batch: 1, enabled: true }], schedule: { enabled: false, mode: 'weekly', weekday: 'MON', everyDays: 7, time: '07:30', env: 'staging', batches: 'all', mail: true, description: 'x' }, runs: [], issues: { items: { k: item, k2: Object.assign({}, item, { theme: 'Craft', id: 'V-06' }) } }, themeStatus: [], checklist: [{ id: 'V-10', title: 'Tick', severity: 'minor' }], library: {} };
  const prog = { running: true, runId: 'r1', env: 'staging', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: 'testing', mode: 'background', totals: { pass: 1, fail: 1, na: 0, review: 0 }, current: null, events: [],
    themes: [{ name: 'Atelier', batch: 1, status: 'done', step: 'finished', fail: 0, pass: 1, activeMs: 1000 }, { name: 'Dawn', batch: 1, status: 'done', step: 'finished', fail: 1, pass: 0, activeMs: 1000 }, { name: 'Craft', batch: 1, status: 'queued', step: '', fail: 0, pass: 0 }] };
  return http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(base);
    if (req.url === '/api/progress') return send(prog);
    if (req.url === '/api/me') { res.writeHead(401); return res.end('{}'); }
    if (req.url.startsWith('/runs/')) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
}
const listenOn = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const hash = (page) => page.evaluate(() => location.hash);

test('dashboard: Back button, breadcrumbs, the theme drawer in the address, previous / next, links to every page', async () => {
  const srv = stub();
  await listenOn(srv);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    await page.goto(url + '#overview');
    await page.waitForSelector('#nav a');
    // every page is one click away, and the brand goes home
    assert.deepStrictEqual(await page.locator('#nav a').evaluateAll((a) => a.map((x) => x.getAttribute('href').slice(1))), TABS);
    assert.strictEqual(await page.getAttribute('a.brand', 'href'), '#overview');
    assert.strictEqual(await page.isDisabled('#back'), true, 'nothing to go back to on the first page');
    assert.match(await page.textContent('#crumbs'), /Theme check\s*›\s*Overview/);

    await page.click('#nav a[href="#live"]');
    await page.click('#nav a[href="#runs"]');
    await page.waitForFunction(() => /Runs/.test(document.getElementById('crumbs').textContent));
    assert.strictEqual(await page.isDisabled('#back'), false);
    await page.click('#back');
    await page.waitForFunction(() => location.hash === '#live');
    await page.click('#back');
    await page.waitForFunction(() => location.hash === '#overview');
    assert.strictEqual(await page.isDisabled('#back'), true, 'back at the first page');
    await page.click('#nav a[href="#live"]');

    // open a theme: it is in the address, in the breadcrumbs, and Back closes it
    await page.waitForSelector('button[data-theme="Dawn"]');
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on');
    assert.strictEqual(await hash(page), '#live/Dawn');
    assert.match(await page.textContent('#crumbs'), /Theme check\s*›\s*Live\s*›\s*Dawn/);
    await page.click('#back');
    await page.waitForFunction(() => location.hash === '#live' && !document.querySelector('#detail.on'));

    // the drawer's own buttons: Back to Live, previous / next theme (no extra history), the Close that does not leave the tool
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on');
    assert.strictEqual(await page.isDisabled('[data-go="Atelier"]'), false);
    await page.click('[data-go="Craft"]');
    await page.waitForFunction(() => location.hash === '#live/Craft');
    assert.match(await page.textContent('#detail-body h2'), /Craft/);
    assert.strictEqual(await page.isDisabled('#detail-body button[data-go=""]'), true, 'no next theme after the last one');
    await page.click('[data-go="Dawn"]');
    await page.click('#d-close'); // opened by a click: closing goes back one step
    await page.waitForFunction(() => location.hash === '#live' && !document.querySelector('#detail.on'));
    await page.click('#back'); // that was the page before opening the drawer: overview
    await page.waitForFunction(() => location.hash === '#overview');

    // a link typed or shared straight to a theme opens it; Close then stays inside the tool
    await page.goto(url + '#live/Dawn');
    await page.waitForSelector('#detail.on');
    assert.match(await page.textContent('#detail-body h2'), /Dawn/);
    await page.click('#d-close');
    await page.waitForFunction(() => location.hash === '#live' && !document.querySelector('#detail.on'));
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on');
    await page.press('body', 'Escape');
    await page.waitForFunction(() => !document.querySelector('#detail.on'));

    // from inside the drawer to any other page
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on');
    for (const t of ['overview', 'runs', 'themes', 'schedule', 'live']) {
      if (!(await page.locator('#detail.on').count())) { await page.click('button[data-theme="Dawn"]'); await page.waitForSelector('#detail.on'); }
      await page.click(`#detail-body .dnav a[href="#${t}"]`);
      await page.waitForFunction((x) => location.hash === '#' + x && !document.querySelector('#detail.on'), t);
      if (t !== 'live') await page.click('#nav a[href="#live"]');
    }
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on');
    await page.click('#detail-body [data-act="issues"]');
    await page.waitForFunction(() => location.hash === '#issues' && !document.querySelector('#detail.on'));
    assert.strictEqual(await page.inputValue('#f-theme'), 'Dawn', 'the Issue tracker is already filtered to this theme');
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});

test('full report: links to every page of the tool and a way back; the dashboard opens from it', async () => {
  const run = { runId: '2026-11-18-staging', env: 'staging', shop: 's', startedAt: '2026-11-18T07:30:00.000Z', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: 'x', shots: [] }] }] }] };
  const html = render(run, checklist, null);
  assert.match(html, /<nav class="tcnav"/);
  TABS.forEach((t) => assert.ok(html.includes(`href="../../#${t}"`), t));
  assert.match(html, /&larr; Back to the dashboard/);
  assert.ok(!/<script/i.test(html));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nav-'));
  ['config', 'checklist', 'ui'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  fs.rmSync(path.join(root, 'config', 'config.local.json'), { force: true });
  fs.mkdirSync(path.join(root, 'history', 'runs', run.runId), { recursive: true });
  fs.writeFileSync(path.join(root, 'history', 'runs', run.runId, 'results.json'), JSON.stringify(run));
  finalizeRun({ root, cfg: { archive: {} }, run, checklist, trackIssues: true });
  const server = await listen(root, 0, { spawnRun: false, propagate: async () => [] });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${base}/runs/${run.runId}/report.html`);
    await page.waitForSelector('.tcnav');
    for (const t of TABS) {
      await page.goto(`${base}/runs/${run.runId}/report.html`);
      await page.click(`.tcnav a[href="../../#${t}"]`);
      await page.waitForFunction((x) => location.pathname === '/' && location.hash === '#' + x, t);
      await page.waitForSelector('#nav a');
      assert.match(await page.textContent('#crumbs'), /Theme check/);
    }
    await page.goto(`${base}/runs/${run.runId}/report.html`);
    await page.click('.tcnav .back');
    await page.waitForFunction(() => location.pathname === '/' && location.hash === '#runs');
    await page.close();
  } finally { await browser.close(); server.close(); }
});
