// The two theme lists (staging 58 / prod 45), the store library comparison, and evidence shown inline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const checklist = require('../checklist/checklist.json');
const cfgLib = require('../src/config');
const { compareLibrary, saveLibrary } = require('../src/admin/library');
const { render } = require('../src/report/html');
const { flatten } = require('../src/report/compare');
const { updateTracker, emptyTracker } = require('../src/store/tracker');
const { finalizeRun } = require('../src/store/archive');
const { listen } = require('../src/server');

const SRC = path.resolve(__dirname, '..');

test('the lists: staging has 58 themes, prod the first 45, in the order the team gave', () => {
  const all = cfgLib.loadThemes(SRC);
  const staging = cfgLib.themesForEnv(all, 'staging', 10);
  const prod = cfgLib.themesForEnv(all, 'prod', 10);
  assert.strictEqual(staging.length, 58);
  assert.strictEqual(prod.length, 45);
  assert.deepStrictEqual(prod.map((t) => t.name).slice(0, 3), ['Atelier', 'Colorblock', 'Craft']);
  assert.strictEqual(prod[44].name, 'Maximize');
  assert.strictEqual(staging[45].name, 'Pebble');
  assert.strictEqual(staging[57].name, 'Warehouse');
  assert.ok(!prod.some((t) => ['Pebble', 'Motion', 'Warehouse', 'Local'].includes(t.name)), 'the 13 staging-only themes are not on prod');
  assert.deepStrictEqual([...new Set(staging.map((t) => t.batch))], [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(staging.filter((t) => t.batch === 1).length, 10);
  assert.strictEqual(staging.filter((t) => t.batch === 6).length, 8);
  assert.strictEqual(prod.filter((t) => t.batch === 5).length, 5);
  assert.ok(all.every((t) => t.name === t.name.trim()), 'no stray spaces in names');
  const off = all.map((t) => Object.assign({}, t, { enabled: t.name === 'Dawn' ? false : t.enabled }));
  assert.strictEqual(cfgLib.themesForEnv(off, 'prod', 10).length, 44, 'a switched-off theme is skipped');
});

test('library check: present, missing, extras and duplicates', () => {
  const wanted = [{ name: 'Dawn' }, { name: 'Craft' }, { name: 'Palo Alto' }, { name: 'Be Yours' }];
  const lib = [{ id: '1', name: 'Horizon' }, { id: '2', name: 'Craft' }, { id: '3', name: 'Dawn' }, { id: '4', name: 'Craft' }, { id: '5', name: 'palo alto' }];
  const r = compareLibrary(wanted, lib);
  assert.deepStrictEqual(r.present.map((p) => p.name), ['Dawn', 'Craft', 'Palo Alto']);
  assert.deepStrictEqual(r.missing, ['Be Yours']);
  assert.deepStrictEqual(r.extras.map((e) => e.name), ['Horizon']);
  assert.deepStrictEqual(r.duplicates.map((d) => d.name), ['Craft']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lib-'));
  const saved = saveLibrary(root, {}, 'staging', wanted, lib);
  assert.strictEqual(saved.inStore, 5);
  assert.ok(fs.existsSync(path.join(root, 'history', 'data', 'library-staging.json')));
});

test('tracker keeps the evidence of the latest failure', () => {
  const run = { runId: 'r1', env: 'staging', startedAt: '2026-11-18T01:00:00Z', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', video: 'dawn/vertical-desktop/video.webm', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: 'x', shots: ['dawn/vertical-desktop/a.png', 'dawn/vertical-desktop/b.png'] }] }] }] };
  const t = updateTracker(emptyTracker(), run, flatten(run), checklist);
  const it = t.items['staging|Dawn|vertical|V-10'];
  assert.deepStrictEqual(it.evidence, { run: 'r1', shots: ['dawn/vertical-desktop/a.png', 'dawn/vertical-desktop/b.png'], video: 'dawn/vertical-desktop/video.webm' });
});

test('the report shows pictures and a video player in the page, not behind a link', () => {
  const run = { runId: 'r1', env: 'staging', shop: 's', startedAt: '2026-11-18T01:00:00Z', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', video: 'dawn/vertical-desktop/video.webm', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: 'no tick', shots: ['dawn/vertical-desktop/a.png'] }] }] }] };
  const html = render(run, checklist, null);
  assert.match(html, /<img loading="lazy" src="dawn\/vertical-desktop\/a\.png"/);
  assert.match(html, /<video class="ev" controls preload="metadata" src="dawn\/vertical-desktop\/video\.webm">/);
  assert.ok(!/<details class="ev">/.test(html));
  assert.ok(!/evidence<\/summary>/.test(html));
});

test('dashboard: lists, library status, and pictures + video shown inline in the issue tracker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lists-'));
  ['config', 'checklist', 'ui'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  const run = { runId: '2026-11-18-staging', env: 'staging', shop: 's', startedAt: '2026-11-18T01:00:00Z', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', video: 'dawn/vertical-desktop/video.webm', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: 'no tick', shots: ['dawn/vertical-desktop/a.png'] }] }] }] };
  const rd = path.join(root, 'history', 'runs', run.runId);
  fs.mkdirSync(path.join(rd, 'dawn', 'vertical-desktop'), { recursive: true });
  // a real 1x1 PNG, so the browser can decode it
  fs.writeFileSync(path.join(rd, 'dawn', 'vertical-desktop', 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(rd, 'dawn', 'vertical-desktop', 'video.webm'), 'v');
  fs.writeFileSync(path.join(rd, 'results.json'), JSON.stringify(run));
  finalizeRun({ root, cfg: {}, run, checklist, trackIssues: true });
  saveLibrary(root, {}, 'staging', cfgLib.themesForEnv(cfgLib.loadThemes(root), 'staging', 10), [{ id: '1', name: 'Horizon' }, { id: '2', name: 'Dawn' }, { id: '3', name: 'Dawn' }, { id: '4', name: 'Craft' }, { id: '5', name: 'Foo Theme' }]);
  const server = await listen(root, 0, { spawnRun: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/#themes');
    await page.waitForSelector('#t-env');
    let txt = await page.textContent('main');
    assert.match(txt, /58 to test in 6 batch/);
    assert.match(txt, /in the store library now: 3, missing: 55/);
    assert.match(txt, /Also in the store but not in this list: Foo Theme/);
    assert.match(txt, /Duplicates in the store: Dawn x2/);
    await page.selectOption('#t-env', 'prod');
    await page.waitForFunction(() => /45 to test in 5 batch/.test(document.querySelector('main').textContent));
    assert.ok(!(await page.textContent('main')).includes('Pebble'), 'staging-only themes are not on the prod list');
    await page.selectOption('#t-env', 'staging');
    await page.waitForFunction(() => /58 to test/.test(document.querySelector('main').textContent));
    await page.screenshot({ path: path.join(SRC, 'test', '_ui-themes2.png') });
    await page.click('nav a[href="#issues"]');
    await page.waitForSelector('.ev');
    assert.strictEqual(await page.locator('.ev img').count(), 1);
    assert.strictEqual(await page.locator('.ev video').count(), 1);
    await page.waitForFunction(() => { const i = document.querySelector('.ev img'); return i && i.complete && i.naturalWidth > 0; });
    await page.click('.ev img');
    assert.ok(await page.isVisible('#lightbox img'), 'clicking a picture enlarges it');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.isVisible('#lightbox')));
    assert.deepStrictEqual(errors, []);
    await page.close();
  } finally { await browser.close(); server.close(); }
});
