// Removing a run (here and on Cloudflare), the slider-dot measurement, and the run pages of any date.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { PNG } = require('pngjs');
const checklist = require('../checklist/checklist.json');
const { finalizeRun } = require('../src/store/archive');
const { deleteRuns } = require('../src/store/delete');
const { dotsOnLine } = require('../src/checks/run');

const SRC = path.resolve(__dirname, '..');
const run = (runId, date, spec) => ({
  runId, env: 'staging', shop: 's', startedAt: `${date}T07:30:00.000Z`,
  themes: Object.entries(spec).map(([name, results]) => ({ name, passes: [{ layout: 'vertical', viewport: 'desktop', results: results.map(([id, status]) => ({ id, layout: 'vertical', status, detail: '', shots: [] })) }] })),
});

test('removing a run: folder, index line, issue tracker and live progress follow; a run in progress is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-del-'));
  ['config', 'checklist'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(root, d), { recursive: true }));
  fs.rmSync(path.join(root, 'config', 'config.local.json'), { force: true });
  const cfg = { archive: {} };
  const runs = [run('2026-11-19-staging', '2026-11-19', { Dawn: [['V-10', 'fail']] }), run('2026-11-20-staging', '2026-11-20', { Dawn: [['V-10', 'fail']], Craft: [['V-06', 'fail']] }), run('2026-11-20-staging-audit', '2026-11-20', { Dawn: [['V-10', 'pass']] })];
  runs.forEach((r) => { const d = path.join(root, 'history', 'runs', r.runId); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'results.json'), JSON.stringify(r)); finalizeRun({ root, cfg, run: r, checklist, trackIssues: true }); });
  const rd = (...p) => JSON.parse(fs.readFileSync(path.join(root, 'history', ...p), 'utf8'));
  assert.ok(rd('data', 'issues.json').items['staging|Craft|vertical|V-06'], 'the tracker knows Craft from the run of the 20th');
  fs.writeFileSync(path.join(root, 'history', 'data', 'progress.json'), JSON.stringify({ running: false, runId: '2026-11-20-staging-audit', themes: [] }));

  assert.throws(() => deleteRuns({ root, cfg, runIds: ['../x'], checklist }), /not a run id/);
  const r = deleteRuns({ root, cfg, runIds: ['2026-11-20-staging', '2026-11-20-staging-audit', 'nope'], checklist });
  assert.deepStrictEqual(r.removed.sort(), ['2026-11-20-staging', '2026-11-20-staging-audit']);
  assert.deepStrictEqual(r.missing, ['nope']);
  assert.strictEqual(r.progressCleared, true);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'history', 'runs')), ['2026-11-19-staging']);
  assert.deepStrictEqual(rd('data', 'runs.json').map((x) => x.runId), ['2026-11-19-staging']);
  assert.strictEqual(rd('data', 'issues.json').items['staging|Craft|vertical|V-06'], undefined, 'what only that run knew is forgotten');
  assert.ok(rd('data', 'issues.json').items['staging|Dawn|vertical|V-10'], 'what the other run knew stays');
  assert.strictEqual(fs.existsSync(path.join(root, 'history', 'data', 'progress.json')), false);

  // a run that is still going cannot be removed
  fs.writeFileSync(path.join(root, 'history', 'data', 'progress.json'), JSON.stringify({ running: true, pid: process.pid, runId: '2026-11-19-staging', themes: [] }));
  assert.throws(() => deleteRuns({ root, cfg, runIds: ['2026-11-19-staging'], checklist }), /still going/);
});

test('Cloudflare: DELETE run/<id> removes every file of that run only, in pages; the token is required', async () => {
  const store = new Map();
  const R2 = {
    async put(k, v) { store.set(k, String(v)); },
    async get(k) { return store.has(k) ? { body: store.get(k), text: async () => store.get(k) } : null; },
    async delete(k) { (Array.isArray(k) ? k : [k]).forEach((x) => store.delete(x)); },
    async list({ prefix, cursor }) { const all = Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort(); const rest = cursor ? all.filter((k) => k > cursor) : all; const page = rest.slice(0, 2); return { objects: page.map((key) => ({ key })), truncated: rest.length > 2, cursor: page[page.length - 1] }; }, // like R2: the cursor is a position in the key order, so deleting a page does not move it
  };
  const env = { STORE: R2, INGEST_TOKEN: 'ingest-token-1234567' };
  ['runs/r1/report.html', 'runs/r1/results.json', 'runs/r1/dawn/a.png', 'runs/r1/dawn/b.png', 'runs/r1/overrides.json', 'runs/r10/report.html', 'runs/r2/report.html', 'data/progress.json'].forEach((k) => store.set(k, 'x'));
  const ingest = await import(pathToFileURL(path.join(SRC, 'functions/api/ingest/[[path]].js')).href);
  const del = (p, auth) => ingest.onRequestDelete({ request: new Request('https://x.dev/api/ingest/' + p, { method: 'DELETE', headers: auth === false ? {} : { authorization: 'Bearer ' + env.INGEST_TOKEN } }), env, params: { path: p.split('/') } });
  assert.strictEqual((await del('run/r1', false)).status, 401);
  assert.strictEqual((await del('run/..%2Fx')).status, 400);
  assert.strictEqual((await del('run/a b')).status, 400);
  const r = await (await del('run/r1')).json();
  assert.strictEqual(r.removed, 5, 'all five files of r1, over three pages');
  assert.deepStrictEqual(Array.from(store.keys()).sort(), ['data/progress.json', 'runs/r10/report.html', 'runs/r2/report.html'], 'r10 and r2 are not touched');
  assert.strictEqual((await (await del('progress')).json()).ok, true);
  assert.strictEqual(store.has('data/progress.json'), false);
  assert.strictEqual((await del('nothing')).status, 404);
});

test('slider dots: the middle of each dot against the middle of the line, read from the picture', () => {
  const draw = (dotDy) => {
    const W = 260, H = 32, png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H * 4; i += 4) { png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255; }
    const px = (x, y) => { const i = (y * W + x) * 4; png.data[i] = 51; png.data[i + 1] = 51; png.data[i + 2] = 51; };
    for (let x = 20; x < 240; x++) for (let y = 14; y < 19; y++) px(x, y); // the line: 5px thick, middle at y = 16.5
    [30, 230].forEach((cx) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if ((x - cx) ** 2 + (y - (16.5 + dotDy)) ** 2 <= 8 * 8) px(x, y); } }); // dots of 16px
    return PNG.sync.write(png);
  };
  const ok = dotsOnLine(draw(0));
  assert.strictEqual(ok.dots.length, 2);
  ok.dots.forEach((d) => assert.ok(Math.abs(d.centre - 16.5) <= 1, 'centred dot: ' + d.centre));
  const off = dotsOnLine(draw(5));
  assert.strictEqual(off.dots.length, 2);
  off.dots.forEach((d) => assert.ok(Math.abs(d.centre - 16.5) >= 4, 'a dot 5px low is seen as 5px low: ' + d.centre));
  assert.strictEqual(dotsOnLine(draw(0)).dots[0].size >= 15, true);
});
