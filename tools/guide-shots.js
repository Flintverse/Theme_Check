// Takes the pictures of the user guide (ui/guide/*.png) from the real dashboard page, filled with made-up demo data, so no
// store name, e-mail address or real result ever ends up in the repository.
//   node tools/guide-shots.js            (run it when no test run is going: it opens a few Chrome windows)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');
const checklist = require('../checklist/checklist.json');
const { renderAll } = require('../src/report/html');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'ui', 'guide');
fs.mkdirSync(OUT, { recursive: true });
const ui = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'));
const title = (id) => (checklist.items.find((i) => i.id === id) || {}).title || id;

// ---- made-up data
const RUN = '2026-11-20-staging';
const res = (id, layout, status, detail, shots) => ({ id, layout, status, detail: detail || '', shots: shots || [] });
const shot = (n) => `craft/vertical-desktop/${n}.png`;
const demoRun = {
  runId: RUN, env: 'staging', shop: 'demo-store', startedAt: '2026-11-20T02:00:00.000Z',
  themes: ['Atelier', 'Craft', 'Dawn'].map((name, i) => ({
    name, passes: [{ layout: 'vertical', viewport: 'desktop', results: [
      res('V-02', 'vertical', 'pass'),
      res('V-10', 'vertical', i === 1 ? 'fail' : 'pass', i === 1 ? '"In Stock" was selected but the box looks the same as before: no dark fill or tick.' : '', i === 1 ? [shot('10-V-10-after-click')] : []),
      res('V-06', 'vertical', i === 1 ? 'fail' : 'pass', i === 1 ? "Findter's scroll-to-top button is not visible after scrolling." : '', i === 1 ? [shot('11-V-06-fail')] : []),
      res('V-04', 'vertical', 'pass', 'Price slider: both dots are on the middle of the line (off by 0.5 and 0.5 px).'),
      res('V-12', 'vertical', 'pass', '36 Findter icon(s) measured: all between 6 and 27px, none stretched or empty.'),
      res('V-09', 'vertical', i === 2 ? 'review' : 'pass', i === 2 ? 'Look at the picture.' : '', []),
    ] }, { layout: 'horizontal', viewport: 'desktop', results: [res('V-04', 'horizontal', 'pass', 'Price slider: both dots are on the middle of the line.'), res('V-06', 'horizontal', 'pass')] }],
  })),
};
const progress = {
  running: true, runId: RUN, env: 'staging', startedAt: '2026-11-20T02:00:00.000Z', updatedAt: new Date().toISOString(), phase: 'testing', mode: 'background (off-screen window)',
  etaMinutes: 38, counts: { total: 6, done: 2, left: 4, failedSetup: 0 }, totals: { pass: 31, fail: 4, na: 3, review: 2 },
  current: { theme: 'Craft', status: 'testing', step: 'Checking the horizontal layout (desktop)', since: new Date().toISOString() },
  events: [{ t: new Date().toISOString(), msg: 'Testing Craft' }],
  themes: [
    { name: 'Atelier', batch: 1, status: 'done', step: 'Tested and deleted from the store', fail: 0, pass: 14, review: 0, activeMs: 262000 },
    { name: 'Dawn', batch: 1, status: 'done', step: 'finished', fail: 1, pass: 12, review: 1, activeMs: 281000 },
    { name: 'Craft', batch: 1, status: 'testing', step: 'Checking the horizontal layout (desktop)', fail: 3, pass: 5, review: 1, activeMs: 120000, activeSince: new Date().toISOString() },
    { name: 'Refresh', batch: 1, status: 'installed', step: 'Installed. Waiting until it shows in the theme list...', fail: 0, pass: 0, review: 0 },
    { name: 'Rise', batch: 1, status: 'queued', step: '', fail: 0, pass: 0, review: 0 },
    { name: 'Ritual', batch: 1, status: 'queued', step: '', fail: 0, pass: 0, review: 0 },
  ],
};
const state = {
  readOnly: true, mediaLocal: true, envs: ['staging'], themes: progress.themes.map((t) => ({ name: t.name, envs: ['staging'], batch: 1, enabled: true })),
  schedule: { enabled: true, mode: 'weekly', weekday: 'MON', everyDays: 7, time: '09:00', env: 'staging', batches: 'all', mail: true, description: 'Every week on MON at 09:00' },
  runs: [
    { runId: RUN, date: '2026-11-20', env: 'staging', themesTested: 3, themesTotal: 3, themesWithIssues: 2, failedChecks: 3, newCount: 1, stillCount: 2, fixedCount: 1, worstThemes: [{ theme: 'Craft', fails: 2 }], themeNames: ['Atelier', 'Craft', 'Dawn'], totals: {} },
    { runId: '2026-11-13-staging', date: '2026-11-13', env: 'staging', themesTested: 3, themesTotal: 3, themesWithIssues: 3, failedChecks: 6, newCount: 0, stillCount: 6, fixedCount: 0, worstThemes: [{ theme: 'Dawn', fails: 3 }], themeNames: ['Atelier', 'Craft', 'Dawn'], totals: {} },
  ],
  issues: { items: {} }, themeStatus: [], checklist: checklist.items.map((i) => ({ id: i.id, title: i.title, severity: i.severity })), library: {},
  latest: null,
};

// a plain "product page" picture, so the guide shows a picture without showing any real store
async function placeholder(browser, file, label) {
  const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await p.setContent(`<body style="margin:0;font:16px system-ui;background:#fff"><div style="padding:18px 22px;border-bottom:1px solid #ddd;display:flex;gap:18px"><b>demo store</b><span>Home</span><span>Catalog</span><span>Contact</span></div>
    <div style="display:flex;gap:18px;padding:18px 22px"><div style="width:150px"><b>Filter by</b><div style="margin-top:10px;display:grid;gap:8px"><label><span style="display:inline-block;width:14px;height:14px;border:1px solid #333;margin-right:6px;vertical-align:middle"></span>In Stock</label><label><span style="display:inline-block;width:14px;height:14px;border:1px solid #333;margin-right:6px;vertical-align:middle"></span>Out of stock</label></div></div>
    <div style="flex:1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">${'<div style="height:150px;background:#eceeed;border-radius:6px"></div>'.repeat(3)}</div></div>
    <div style="position:absolute;right:16px;bottom:14px;width:48px;height:48px;border-radius:50%;background:#333;opacity:.12"></div>
    <div style="position:absolute;left:22px;bottom:10px;color:#b42318;font-weight:700">${label}</div></body>`);
  await p.screenshot({ path: file });
  await p.close();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const picDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guide-'));
  fs.mkdirSync(path.join(picDir, 'craft', 'vertical-desktop'), { recursive: true });
  await placeholder(browser, path.join(picDir, 'craft', 'vertical-desktop', '10-V-10-after-click.png'), 'the box did not change when selected');
  await placeholder(browser, path.join(picDir, 'craft', 'vertical-desktop', '11-V-06-fail.png'), 'no scroll-to-top arrow');
  const pages = renderAll(demoRun, checklist, null);

  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = req.url.split('?')[0];
    if (u === '/api/state') return send(state);
    if (u === '/api/progress') return send(progress);
    if (u === '/api/me') return send({ email: 'you@bsscommerce.com', name: 'You', canEdit: true });
    if (u === '/api/config' && req.method === 'PUT') return send({ ok: true, rev: 1 });
    if (u === '/api/config-status') return send({ rev: 1, status: { rev: 1, ok: true, at: new Date().toISOString(), steps: [{ step: 'Saved on the test machine', ok: true, detail: 'Every week on MON at 09:00' }, { step: 'Windows Task Scheduler', ok: true, detail: 'Every week on MON at 09:00' }, { step: 'Cloudflare', ok: true }, { step: 'GitHub', ok: true, detail: 'committed and pushed to GitHub' }] } });
    if (u === `/runs/${RUN}/results.json`) return send(demoRun);
    if (u === `/runs/${RUN}/overrides.json`) return send({ rev: 0, items: {} });
    const page = pages.find((p) => u === `/runs/${RUN}/${p.file}`);
    if (page) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page.html); }
    if (u.startsWith(`/runs/${RUN}/craft/`)) { const f = path.join(picDir, u.slice(`/runs/${RUN}/`.length)); if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(f)); } }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // numbered red circles on top of the page, at the top-left corner of an element
  const mark = (page, items) => page.evaluate((list) => {
    list.forEach(([sel, n, dx, dy]) => {
      const e = document.querySelector(sel); if (!e) return;
      const r = e.getBoundingClientRect();
      const b = document.createElement('div');
      b.textContent = String(n);
      b.style.cssText = `position:fixed;z-index:99999;left:${Math.max(2, r.left + (dx || 0) - 12)}px;top:${Math.max(2, r.top + (dy || 0) - 12)}px;width:24px;height:24px;border-radius:50%;background:#d92d20;color:#fff;font:700 14px/24px system-ui;text-align:center;box-shadow:0 0 0 2px #fff`;
      document.body.appendChild(b);
    });
  }, items);
  const open = async (hash, size) => { const p = await browser.newPage({ viewport: size || { width: 1200, height: 820 } }); await p.goto(base + '/' + hash); await p.waitForSelector('#nav a'); await p.waitForTimeout(1200); return p; };
  const out = (n) => path.join(OUT, n);

  // 1 menu
  let p = await open('#overview', { width: 1200, height: 300 });
  await p.click('#nav a[href="#live"]'); // so the Back button is active in the picture
  await p.waitForFunction(() => document.getElementById('who').textContent.length > 0, null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(500);
  await mark(p, [['#back', 1, 6, 2], ['#crumbs b', 2, 46, 8], ['#nav a[href="#overview"]', 3, 6, 2]]);
  await p.screenshot({ path: out('nav.png'), clip: { x: 0, y: 0, width: 1200, height: await p.evaluate(() => Math.ceil(document.querySelector('header').getBoundingClientRect().height) + 6) } });
  await p.close();

  // 2 live
  p = await open('#live', { width: 1200, height: 860 });
  await mark(p, [['.pbar', 1, 8, 0], ['main a .navbtn', 2, 8, 0], ['main .kpis', 3, 6, 0], ['button[data-theme="Craft"]', 4, -16, 8]]);
  await p.screenshot({ path: out('live.png') });
  await p.close();

  // 3 drawer
  p = await open('#live', { width: 1200, height: 900 });
  await p.click('button[data-theme="Craft"]');
  await p.waitForSelector('#detail.on .chk');
  await p.waitForTimeout(1000);
  await mark(p, [['#d-close', 1, 4, 0], ['#detail-body .kpis', 2, 6, 0], ['#detail-body .chk tbody tr td:nth-child(3)', 3, -10, 8], ['#detail-body .ev img', 4, 4, 4], ['#detail-body .vgrid', 5, -4, 0]]);
  await p.screenshot({ path: out('drawer.png') });
  await p.close();

  // 4 a report of one theme
  p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await p.goto(`${base}/runs/${RUN}/report-craft.html`);
  await p.waitForSelector('.tcnav');
  await p.waitForTimeout(600);
  await p.evaluate(() => { const f = document.querySelector('figure'); if (f) f.scrollIntoView({ block: 'center' }); });
  await p.waitForTimeout(400);
  await mark(p, [['.tcnav .back', 1, 6, 0], ['.tcnav .chg-link', 2, 6, 0], ['figure img', 3, 6, 6]]);
  await p.screenshot({ path: out('report.png') });
  await p.close();

  // 5 runs
  p = await open('#runs', { width: 1200, height: 520 });
  await p.click('summary');
  await p.waitForTimeout(400);
  await mark(p, [['main tbody tr td', 1, 4, 4], ['main tbody tr td:last-child a', 2, -14, 8], ['main tbody tr td:last-child summary', 3, -14, 10]]);
  await p.screenshot({ path: out('runs.png') });
  await p.close();

  // 6 schedule, after Save
  p = await open('#schedule', { width: 1200, height: 900 });
  await p.waitForSelector('#s-save');
  await p.waitForFunction(() => !document.querySelector('#s-mode').disabled, null, { timeout: 8000 });
  await p.click('#s-save');
  await p.waitForFunction(() => /Applied by the test machine/.test(document.querySelector('#s-msg').textContent), null, { timeout: 15000 });
  await mark(p, [['#s-mode', 1, 48, -8], ['#s-save', 2, 4, 0], ['#save-steps', 3, 4, 0]]);
  await p.screenshot({ path: out('schedule.png') });
  await p.close();

  await browser.close();
  srv.close();
  console.log('pictures written to ' + OUT + ': ' + fs.readdirSync(OUT).join(', '));
})().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; });
