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

test('reports: one page per theme next to the full one; the drawer links to the theme only, the Live page to the full report with its date', async () => {
  const { renderAll, themeReportFile } = require('../src/report/html');
  const { writeReports } = require('../src/report/write');
  const mk = (name, st) => ({ name, passes: [{ layout: 'vertical', viewport: 'desktop', results: [{ id: 'V-10', layout: 'vertical', status: st, detail: name + ' detail', shots: [] }] }] });
  const run = { runId: '2026-11-18-staging', env: 'staging', shop: 's', startedAt: '2026-11-18T07:30:00.000Z', themes: [mk('Dawn', 'fail'), mk('Craft Plus', 'pass')] };
  const pages = renderAll(run, checklist, null);
  assert.deepStrictEqual(pages.map((p) => p.file), ['report.html', 'report-dawn.html', 'report-craft-plus.html']);
  assert.strictEqual(themeReportFile('Craft Plus'), 'report-craft-plus.html');
  const full = pages[0].html, dawn = pages[1].html;
  assert.ok(full.includes('Dawn detail') && full.includes('Craft Plus detail'), 'the full report has every theme');
  assert.ok(dawn.includes('Dawn detail') && !dawn.includes('Craft Plus detail'), 'the theme report has that theme only');
  assert.match(dawn, /<h1>Dawn: theme report<\/h1>/);
  assert.match(dawn, /<a href="report.html">Full report \(all themes\)<\/a>/);
  assert.match(dawn, /<a class="back" href="..\/..\/#runs">/);
  assert.ok(!full.includes('Full report (all themes)'));
  // files on disk, and a theme that left the run loses its page
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rep-'));
  writeReports(dir, run, checklist, null);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['report-craft-plus.html', 'report-dawn.html', 'report.html']);
  writeReports(dir, Object.assign({}, run, { themes: [run.themes[0]] }), checklist, null);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['report-dawn.html', 'report.html']);

  // in the page
  const srv = stub();
  await listenOn(srv);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://127.0.0.1:${srv.address().port}/#live`);
    await page.waitForSelector('button[data-theme="Dawn"]');
    const live = await page.locator('main a[href$="/report.html"]').first();
    assert.match(await live.textContent(), /Open the full theme report · \d{4}-\d{2}-\d{2}/);
    assert.match(await live.getAttribute('href'), /^runs\/r1\/report\.html$/);
    assert.match(await page.textContent('main'), /Full theme report/);
    await page.click('button[data-theme="Dawn"]');
    await page.waitForSelector('#detail.on');
    assert.strictEqual(await page.locator('#detail-body a[href$="/report.html"]').count(), 0, 'no all-themes report inside the drawer');
    assert.strictEqual(await page.getAttribute('#detail-body a[href$="report-dawn.html"]', 'href'), 'runs/r1/report-dawn.html');
    assert.match(await page.textContent('#detail-body'), /Report of this theme/);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});

test('any run: the Runs tab lists the themes, a theme of an old run opens in the drawer, and its results can be changed there', async () => {
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const results = { runId: 'old-run', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: 'old failure', shots: [] }] }] }, { name: 'Craft', passes: [] }] };
  const base = { readOnly: false, mediaLocal: true, envs: ['staging'], themes: [], schedule: { enabled: false, mode: 'weekly', weekday: 'MON', everyDays: 7, time: '07:30', env: 'staging', batches: 'all', mail: true, description: 'x' },
    runs: [{ runId: 'old-run', date: '2026-11-10', env: 'staging', themesTested: 2, themesTotal: 2, themesWithIssues: 1, failedChecks: 1, newCount: 0, fixedCount: 0, worstThemes: [], themeNames: ['Dawn', 'Craft'] }],
    issues: { items: {} }, themeStatus: [], checklist: [{ id: 'V-10', title: 'Tick', severity: 'minor' }], library: {} };
  const puts = [];
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(base);
    if (req.url === '/api/progress') return send({ running: false, none: true });
    if (req.url === '/runs/old-run/results.json') return send(results);
    if (req.url === '/runs/old-run/overrides.json') return send({ rev: 0, items: {} });
    if (req.url === '/api/overrides' && req.method === 'PUT') { let b = ''; req.on('data', (d) => { b += d; }).on('end', () => { const j = JSON.parse(b); puts.push(j); send({ ok: true, rev: 1, items: j.status ? { [j.key]: { status: j.status, orig: j.orig, by: 'you' } } : {} }); }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await listenOn(srv);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.address().port}/#runs`);
    await page.waitForSelector('summary');
    await page.click('summary');
    await page.click('button[data-run="old-run"][data-theme="Dawn"]');
    await page.waitForSelector('#detail.on .chk');
    assert.strictEqual(await hash(page), '#runs/old-run/Dawn');
    assert.match(await page.textContent('#crumbs'), /Runs\s*›\s*old-run\s*›\s*Dawn/);
    assert.match(await page.textContent('#detail-body'), /old failure/);
    assert.match(await page.textContent('#detail-body'), /Back to Runs/);
    assert.strictEqual(await page.isDisabled('#detail-body [data-go="Craft"]'), false, 'next theme of that run');
    // change a result of that old run
    await page.locator('input[data-vk="Dawn|vertical|desktop|V-10"][data-v="pass"]').check();
    await page.waitForFunction(() => /Saved/.test(document.getElementById('detail-body').textContent));
    assert.deepStrictEqual(puts[0], { run: 'old-run', key: 'Dawn|vertical|desktop|V-10', status: 'pass', orig: 'fail' });
    assert.strictEqual(await page.getAttribute('#detail-body a[href$="report-dawn.html"]', 'href'), 'runs/old-run/report-dawn.html');
    // a shared link opens it too, and Close stays inside the tool
    await page.goto(`http://127.0.0.1:${srv.address().port}/#runs/old-run/Dawn`);
    await page.waitForSelector('#detail.on .chk');
    await page.click('#d-close');
    await page.waitForFunction(() => location.hash === '#runs' && !document.querySelector('#detail.on'));
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});

test('a theme report links to the dashboard to change its results; the full report links each theme to its own report', () => {
  const { renderAll } = require('../src/report/html');
  const mk = (name) => ({ name, passes: [{ layout: 'vertical', viewport: 'desktop', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: name + ' detail', shots: [] }] }] });
  const pages = renderAll({ runId: '2026-11-20-staging', env: 'staging', shop: 's', startedAt: '2026-11-20T07:30:00.000Z', themes: [mk('Dawn'), mk('Craft Plus')] }, checklist, null);
  assert.match(pages[1].html, /href="..\/..\/#runs\/2026-11-20-staging\/Dawn">Change the results of this theme/);
  assert.match(pages[2].html, /#runs\/2026-11-20-staging\/Craft%20Plus/);
  assert.ok(pages[0].html.includes('href="report-dawn.html">Dawn</a>') && pages[0].html.includes('href="report-craft-plus.html">Craft Plus</a>'));
  assert.ok(!pages[0].html.includes('Change the results of this theme'), 'only the theme reports have it');
});
