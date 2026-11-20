// Build a read-only copy of the dashboard (ui + data + reports + pictures) in site/, ready for any static host
// (Cloudflare Pages, GitHub Pages, a shared folder). Only reports and pictures are copied.
const fs = require('fs');
const path = require('path');
const cfgLib = require('./config');
const sched = require('./schedule');
const { runsDir, dataDir } = require('./store/paths');
const { themeStatus } = require('./store/tracker');
const { loadLibraries } = require('./admin/library');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

function copyTree(src, dst, filter) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach((e) => {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d, filter);
    else if (!filter || filter(s)) { fs.copyFileSync(s, d); n++; }
  });
  return n;
}

// The dashboard data as a read-only snapshot (used by `publish` and pushed to Cloudflare by `sync`).
function buildState(root, cfg, opts) {
  const data = dataDir(root, cfg);
  const issues = readJson(path.join(data, 'issues.json'), { items: {} });
  return {
    readOnly: true,
    mediaLocal: !!(opts && opts.remote), // true on Cloudflare (R2 serves /runs/...); a plain static copy has no pictures
    evidenceUrl: (cfg.evidence && cfg.evidence.driveUrl) || '',
    envs: Object.keys(cfg.envs),
    themes: cfgLib.loadThemes(root),
    schedule: Object.assign({}, sched.loadSchedule(root), { description: sched.describe(sched.loadSchedule(root)) }),
    task: null,
    runs: readJson(path.join(data, 'runs.json'), []),
    issues,
    themeStatus: themeStatus(issues),
    library: loadLibraries(root, cfg),
    checklist: cfgLib.loadChecklist(root).items.map((i) => ({ id: i.id, title: i.title, severity: i.severity })),
    publishedAt: new Date().toISOString(),
  };
}

function publish(root, cfg, outDir, opts) {
  const out = path.resolve(root, outDir || 'site');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'api'), { recursive: true });
  fs.copyFileSync(path.join(root, 'ui', 'index.html'), path.join(out, 'index.html'));
  // the user guide and its pictures
  if (fs.existsSync(path.join(root, 'ui', 'guide.html'))) fs.copyFileSync(path.join(root, 'ui', 'guide.html'), path.join(out, 'guide.html'));
  if (fs.existsSync(path.join(root, 'ui', 'guide'))) copyTree(path.join(root, 'ui', 'guide'), path.join(out, 'guide'));
  const state = buildState(root, cfg);
  // dashboardOnly: for Cloudflare Pages, where the Functions serve the data and the runs from R2
  if (opts && opts.dashboardOnly) return { out, runs: state.runs.length, files: 1 };
  fs.writeFileSync(path.join(out, 'api', 'state.json'), JSON.stringify(state));
  const files = copyTree(runsDir(root, cfg), path.join(out, 'runs'), (f) => !/_debug|current-run/.test(f));
  return { out, runs: state.runs.length, files };
}

module.exports = { publish, buildState };
