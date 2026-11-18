// History: summary numbers, the cross-run issue tracker (fixed / reopened), archive pruning, schedule commands, config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checklist = require('../checklist/checklist.json');
const { flatten } = require('../src/report/compare');
const { buildSummary } = require('../src/store/summary');
const { updateTracker, emptyTracker } = require('../src/store/tracker');
const { finalizeRun } = require('../src/store/archive');
const sched = require('../src/schedule');
const cfgLib = require('../src/config');

const mk = (runId, date, spec) => ({
  runId, env: 'staging', shop: 's', startedAt: `${date}T07:30:00.000Z`,
  themes: Object.entries(spec).map(([name, results]) => name.startsWith('!')
    ? { name: name.slice(1), passes: [], setupFailed: { reason: 'not_in_findter_theme_list', detail: 'x' } }
    : { name, passes: [{ layout: 'vertical', viewport: 'desktop', video: null, results: results.map(([id, status, detail, shots]) => ({ id, layout: 'vertical', status, detail: detail || '', shots: shots || [] })) }] }),
});

const r1 = mk('2026-11-11-staging', '2026-11-11', { Dawn: [['V-10', 'fail', 'no tick'], ['V-03', 'pass']], Craft: [['V-10', 'fail', 'no tick'], ['V-06', 'fail', 'circle only']], Rise: [['V-10', 'pass']], '!Impulse': [] });
const r2 = mk('2026-11-18-staging', '2026-11-18', { Dawn: [['V-10', 'pass'], ['V-03', 'pass']], Craft: [['V-10', 'fail', 'no tick'], ['V-06', 'na']], Rise: [['V-10', 'fail', 'no tick']] });
const r3 = mk('2026-11-25-staging', '2026-11-25', { Dawn: [['V-10', 'fail', 'back again']], Craft: [['V-10', 'pass'], ['V-06', 'pass']], Rise: [['V-10', 'fail', 'no tick']] });

test('summary: counts, worst themes, most common issues, new and fixed', () => {
  const s = buildSummary(r2, checklist, r1);
  assert.strictEqual(s.themesTested, 3);
  assert.strictEqual(s.themesWithIssues, 2);
  assert.strictEqual(s.failedChecks, 2);
  assert.strictEqual(s.newCount, 1, 'Rise is new');
  assert.strictEqual(s.fixedCount, 1, 'Dawn V-10 fixed');
  assert.deepStrictEqual(s.fixed, [{ theme: 'Dawn', layout: 'vertical', id: 'V-10' }]);
  assert.strictEqual(s.topChecks[0].id, 'V-10');
  assert.strictEqual(s.topChecks[0].themes, 2);
  const first = buildSummary(r1, checklist, null);
  assert.strictEqual(first.setupFailures.length, 1);
  assert.strictEqual(first.worstThemes[0].theme, 'Craft');
  assert.strictEqual(first.worstThemes[0].fails, 2);
});

test('tracker: open, fixed on the next passing check, reopened when it comes back', () => {
  let t = emptyTracker();
  t = updateTracker(t, r1, flatten(r1), checklist);
  const dawn = () => t.items['staging|Dawn|vertical|V-10'];
  assert.strictEqual(dawn().status, 'open');
  assert.strictEqual(dawn().firstSeen, '2026-11-11');
  t = updateTracker(t, r2, flatten(r2), checklist);
  assert.strictEqual(dawn().status, 'fixed');
  assert.strictEqual(dawn().fixedOn, '2026-11-18');
  assert.strictEqual(dawn().fixedRun, '2026-11-18-staging');
  t = updateTracker(t, r3, flatten(r3), checklist);
  assert.strictEqual(dawn().status, 'open');
  assert.strictEqual(dawn().reopened, 1);
  assert.strictEqual(dawn().fixedOn, null);
  assert.deepStrictEqual(dawn().history.map((h) => h.s), ['fail', 'pass', 'fail']);
  // a theme that never failed is never tracked
  assert.ok(!t.items['staging|Rise|vertical|V-10'] || t.items['staging|Rise|vertical|V-10'].firstSeen === '2026-11-18');
  // not-testable (na) neither fixes nor reopens
  assert.strictEqual(t.items['staging|Craft|vertical|V-06'].history[1].s, 'na');
  assert.strictEqual(t.items['staging|Craft|vertical|V-06'].status, 'fixed', 'passed on 25/11 after the na');
});

test('tracker: na keeps an open issue open; re-finalising a run does not double count', () => {
  let t = updateTracker(emptyTracker(), r1, flatten(r1), checklist);
  t = updateTracker(t, r2, flatten(r2), checklist);
  const n = t.items['staging|Craft|vertical|V-06'];
  assert.strictEqual(n.status, 'open');
  const before = n.history.length;
  t = updateTracker(t, r2, flatten(r2), checklist);
  assert.strictEqual(t.items['staging|Craft|vertical|V-06'].history.length, before);
});

test('finalizeRun: keeps evidence of failures only, writes summary, tracker and index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-root-'));
  const cfg = { archive: { keepVideosForRuns: 1 } };
  const runDir = path.join(root, 'history', 'runs', r1.runId);
  fs.mkdirSync(path.join(runDir, 'dawn'), { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  ['dawn/pass.png', 'dawn/fail.png'].forEach((f) => fs.writeFileSync(path.join(runDir, f), png));
  fs.writeFileSync(path.join(runDir, 'dawn', 'video.webm'), 'v');
  const run = JSON.parse(JSON.stringify(r1));
  run.themes[0].passes[0].results[0].shots = ['dawn/fail.png'];
  run.themes[0].passes[0].results[1].shots = ['dawn/pass.png'];
  run.themes[0].passes[0].video = 'dawn/video.webm';
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(run));
  const out = finalizeRun({ root, cfg, run, checklist, trackIssues: true });
  assert.ok(fs.existsSync(path.join(runDir, 'dawn', 'fail.png')));
  assert.ok(!fs.existsSync(path.join(runDir, 'dawn', 'pass.png')), 'passing picture removed');
  assert.strictEqual(out.removedEvidence, 1);
  assert.ok(fs.existsSync(path.join(runDir, 'summary.json')));
  assert.ok(fs.existsSync(path.join(runDir, 'report.html')));
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'history', 'data', 'runs.json'), 'utf8'));
  assert.strictEqual(idx[0].runId, r1.runId);
  const tr = JSON.parse(fs.readFileSync(path.join(root, 'history', 'data', 'issues.json'), 'utf8'));
  assert.ok(tr.items['staging|Dawn|vertical|V-10']);
  // a second, newer run pushes the first run past the video retention
  const run2Dir = path.join(root, 'history', 'runs', r2.runId);
  fs.mkdirSync(run2Dir, { recursive: true });
  fs.writeFileSync(path.join(run2Dir, 'results.json'), JSON.stringify(r2));
  const out2 = finalizeRun({ root, cfg, run: JSON.parse(JSON.stringify(r2)), checklist, trackIssues: true });
  assert.strictEqual(out2.droppedVideos, 1);
  assert.ok(!fs.existsSync(path.join(runDir, 'dawn', 'video.webm')));
  const idx2 = JSON.parse(fs.readFileSync(path.join(root, 'history', 'data', 'runs.json'), 'utf8'));
  assert.deepStrictEqual(idx2.map((r) => r.date), ['2026-11-18', '2026-11-11'], 'newest first');
});

test('schedule: validation and the scheduler arguments for daily, weekly, every N days', () => {
  const base = Object.assign({}, sched.DEFAULT, { enabled: true, time: '07:30', env: 'staging', batches: 'all', mail: true });
  assert.deepStrictEqual(sched.validate(base, ['staging', 'prod']), []);
  assert.ok(sched.validate(Object.assign({}, base, { time: '7:30' }), ['staging']).length);
  assert.ok(sched.validate(Object.assign({}, base, { mode: 'everyNDays', everyDays: 0 }), ['staging']).length);
  assert.ok(sched.validate(Object.assign({}, base, { env: 'prod; calc' }), ['staging', 'prod']).length, 'env is checked against the config');
  assert.ok(sched.validate(Object.assign({}, base, { batches: '1; del *' }), ['staging']).length, 'batches is checked');
  const w = sched.schtasksArgs(Object.assign({}, base, { mode: 'weekly', weekday: 'FRI' }), 'C:\\x', 'node.exe');
  assert.deepStrictEqual(w.slice(w.indexOf('/SC')), ['/SC', 'WEEKLY', '/D', 'FRI']);
  const n = sched.schtasksArgs(Object.assign({}, base, { mode: 'everyNDays', everyDays: 3 }), 'C:\\x', 'node.exe');
  assert.deepStrictEqual(n.slice(n.indexOf('/SC')), ['/SC', 'DAILY', '/MO', '3']);
  const d = sched.schtasksArgs(Object.assign({}, base, { mode: 'daily' }), 'C:\\x', 'node.exe');
  assert.deepStrictEqual(d.slice(d.indexOf('/SC')), ['/SC', 'DAILY']);
  assert.match(sched.runCommand(base, 'C:\\x', 'node.exe'), /run --env staging --mail/);
  assert.match(sched.describe(Object.assign({}, base, { mode: 'everyNDays', everyDays: 3 })), /Every 3 days at 07:30/);
  assert.strictEqual(sched.describe(Object.assign({}, base, { enabled: false })), 'Off (no automatic runs).');
});

test('config: themes are cleaned, de-duplicated and re-batched by 10', () => {
  const clean = cfgLib.cleanThemes([{ name: ' Dawn ', batch: 1 }, { name: 'dawn', batch: 2 }, { name: '<b>x</b>' }, { name: '' }, { name: 'Craft', batch: 'x', enabled: false }]);
  assert.deepStrictEqual(clean.map((t) => t.name), ['Dawn', 'Craft']);
  assert.strictEqual(clean[1].enabled, false);
  const many = Array.from({ length: 23 }, (_, i) => ({ name: 'T' + i, batch: 1, enabled: i !== 5 }));
  const b = cfgLib.autoBatch(many, 10);
  assert.strictEqual(b[0].batch, 1);
  assert.strictEqual(b[22].batch, 3);
  assert.strictEqual(b.filter((t) => t.enabled !== false && t.batch === 1).length, 10, 'disabled themes do not take a seat');
});
