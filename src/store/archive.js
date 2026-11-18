// After a run: keep only the evidence that matters, write the overview, update the cross-run tracker and the run index,
// and (optionally) commit the history folder to its own git repo.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { flatten, findPrevious } = require('../report/compare');
const { writeReports } = require('../report/write');
const { buildSummary } = require('./summary');
const { updateTracker, emptyTracker } = require('./tracker');
const { archiveRoot, runsDir, dataDir } = require('./paths');
const ovr = require('./overrides');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };

function walk(dir, out) {
  (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  });
  return out;
}

// Pictures of passing checks are not worth keeping: drop them so a weekly run stays small.
function pruneEvidence(runDir, run) {
  const keep = new Set();
  const verdicts = ovr.readOverrides(runDir).items; // a check a person marked fail or review keeps its picture too
  (run.themes || []).forEach((t) => (t.passes || []).forEach((p) => {
    p.results.forEach((r) => {
      const v = verdicts[ovr.keyFor(t.name, p.layout, p.viewport, r.id)];
      if (r.status === 'fail' || r.status === 'error' || r.status === 'review' || (v && (v.status === 'fail' || v.status === 'review'))) (r.shots || []).forEach((s) => keep.add(path.normalize(path.join(runDir, s))));
      else r.shots = [];
    });
  }));
  let removed = 0;
  walk(runDir, []).filter((f) => /\.png$/i.test(f)).forEach((f) => { if (!keep.has(path.normalize(f))) { fs.unlinkSync(f); removed++; } });
  return removed;
}

function gitPublish(dir, message) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { ok: false, reason: 'archive dir is not a git repo' };
  const git = (args) => spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8' });
  git(['add', '-A']);
  const c = git(['commit', '-m', message]);
  if (c.status !== 0 && /nothing to commit/i.test(c.stdout + c.stderr)) return { ok: true, note: 'nothing new to commit' };
  const p = git(['push']);
  return p.status === 0 ? { ok: true } : { ok: false, reason: (p.stderr || '').slice(0, 200) };
}

// run: the run object (already saved by batch.js). trackIssues=false for ad-hoc URL runs.
function finalizeRun({ root, cfg, run, checklist, trackIssues }) {
  const dir = runsDir(root, cfg);
  const runDir = path.join(dir, run.runId);
  const out = { removedEvidence: pruneEvidence(runDir, run) };
  const prev = findPrevious(dir, run.env, run.runId);
  writeJson(path.join(runDir, 'results.json'), run); // the script's own results, untouched
  const eff = ovr.applyOverrides(run, ovr.readOverrides(runDir)); // with the manual verdicts on top
  writeReports(runDir, eff, checklist, prev);
  const summary = buildSummary(eff, checklist, prev);
  writeJson(path.join(runDir, 'summary.json'), summary);

  const data = dataDir(root, cfg);
  if (trackIssues) {
    const tracker = updateTracker(readJson(path.join(data, 'issues.json'), emptyTracker()), eff, flatten(eff), checklist);
    writeJson(path.join(data, 'issues.json'), tracker);
  }
  const index = readJson(path.join(data, 'runs.json'), []).filter((r) => r.runId !== run.runId);
  index.push(summary);
  index.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  writeJson(path.join(data, 'runs.json'), index);

  if (cfg.archive && cfg.archive.git) out.git = gitPublish(archiveRoot(root, cfg), `Theme check ${run.runId}: ${summary.failedChecks} failing checks on ${summary.themesWithIssues}/${summary.themesTested} themes`);
  out.summary = summary;
  return out;
}

// A manual verdict was added or removed on a finished run: write the report, the summary, the run index and the issue
// tracker again from the script's results plus the verdicts. Safe to repeat.
function refreshRun({ root, cfg, runId, checklist }) {
  const dir = runsDir(root, cfg);
  const runDir = path.join(dir, runId);
  const run = readJson(path.join(runDir, 'results.json'), null);
  if (!run) return { ok: false, reason: 'no results.json for ' + runId };
  const prev = findPrevious(dir, run.env, runId);
  const eff = ovr.applyOverrides(run, ovr.readOverrides(runDir));
  writeReports(runDir, eff, checklist, prev);
  const summary = buildSummary(eff, checklist, prev);
  writeJson(path.join(runDir, 'summary.json'), summary);
  const data = dataDir(root, cfg);
  const idxFile = path.join(data, 'runs.json');
  const index = readJson(idxFile, []);
  const known = index.some((r) => r.runId === runId);
  if (known) { // a run that is still going is not in the index yet: its report is rewritten, nothing else
    writeJson(idxFile, index.map((r) => (r.runId === runId ? summary : r)));
    rebuildTracker({ root, cfg, checklist, index });
  }
  return { ok: true, finalized: known, summary };
}

// The issue tracker from every finished run, oldest first, with the manual verdicts applied. Skipped when a finished run's
// files are gone (the tracker then stays as it was rather than forgetting that history).
function rebuildTracker({ root, cfg, checklist, index }) {
  const dir = runsDir(root, cfg);
  const runs = [];
  for (const s of index) {
    const rd = path.join(dir, s.runId);
    const r = readJson(path.join(rd, 'results.json'), null);
    if (!r) return { ok: false, reason: 'results of ' + s.runId + ' are missing' };
    if (r.env === 'url') continue; // ad-hoc URL runs are not tracked
    runs.push(ovr.applyOverrides(r, ovr.readOverrides(rd)));
  }
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  let tracker = emptyTracker();
  runs.forEach((r) => { tracker = updateTracker(tracker, r, flatten(r), checklist); });
  writeJson(path.join(dataDir(root, cfg), 'issues.json'), tracker);
  return { ok: true, runs: runs.length };
}

module.exports = { finalizeRun, refreshRun, rebuildTracker, pruneEvidence, gitPublish };
