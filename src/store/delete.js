// Remove a run: its folder (report, results, pictures, verdicts), its line in the run index, and everything the issue tracker
// learned from it. Then the numbers are recalculated from the runs that are left.
const fs = require('fs');
const path = require('path');
const { runsDir, dataDir } = require('./paths');
const { rebuildTracker } = require('./archive');

const ID = /^[\w.-]{1,80}$/;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

// Returns { removed: [ids that had a folder or an index line], missing: [ids found nowhere], tracker }.
function deleteRuns({ root, cfg, runIds, checklist }) {
  const dir = runsDir(root, cfg);
  const data = dataDir(root, cfg);
  const removed = [], missing = [];
  const idxFile = path.join(data, 'runs.json');
  let index = readJson(idxFile, []);
  const live = readJson(path.join(data, 'progress.json'), null);
  if (live && live.running && runIds.includes(live.runId) && require('./progress').pidAlive(live.pid)) throw new Error('Run ' + live.runId + ' is still going. Stop it first.');
  for (const id of runIds) {
    if (!ID.test(id)) throw new Error('not a run id: ' + id);
    const folder = path.join(dir, id);
    if (path.dirname(folder) !== dir) throw new Error('not a run id: ' + id);
    const had = fs.existsSync(folder);
    const inIndex = index.some((r) => r.runId === id);
    if (had) fs.rmSync(folder, { recursive: true, force: true });
    if (inIndex) index = index.filter((r) => r.runId !== id);
    (had || inIndex ? removed : missing).push(id);
  }
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(idxFile, JSON.stringify(index, null, 2));
  // the Live page must not keep showing a run that no longer exists
  const progFile = path.join(data, 'progress.json');
  const prog = readJson(progFile, null);
  let progressCleared = false;
  if (prog && runIds.includes(prog.runId) && !prog.running) { fs.rmSync(progFile, { force: true }); progressCleared = true; }
  const tracker = rebuildTracker({ root, cfg, checklist, index });
  return { removed, missing, progressCleared, tracker };
}

module.exports = { deleteRuns, ID };
