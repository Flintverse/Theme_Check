// After a run: keep only the evidence that matters, write the overview, update the cross-run tracker and the run index,
// and (optionally) commit the history folder to its own git repo.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { flatten, findPrevious } = require('../report/compare');
const { render } = require('../report/html');
const { buildSummary } = require('./summary');
const { updateTracker, emptyTracker } = require('./tracker');
const { archiveRoot, runsDir, dataDir } = require('./paths');

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
  (run.themes || []).forEach((t) => (t.passes || []).forEach((p) => {
    p.results.forEach((r) => {
      if (r.status === 'fail' || r.status === 'error' || r.status === 'review') (r.shots || []).forEach((s) => keep.add(path.normalize(path.join(runDir, s))));
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
  writeJson(path.join(runDir, 'results.json'), run);
  fs.writeFileSync(path.join(runDir, 'report.html'), render(run, checklist, prev));
  const summary = buildSummary(run, checklist, prev);
  writeJson(path.join(runDir, 'summary.json'), summary);

  const data = dataDir(root, cfg);
  if (trackIssues) {
    const tracker = updateTracker(readJson(path.join(data, 'issues.json'), emptyTracker()), run, flatten(run), checklist);
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

module.exports = { finalizeRun, pruneEvidence, gitPublish };
