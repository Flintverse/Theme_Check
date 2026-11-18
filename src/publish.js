// Build a read-only copy of the dashboard (ui + data + reports + pictures) in site/, ready for any static host
// (Cloudflare Pages, GitHub Pages, a shared folder). Videos are left out unless asked: they are big.
const fs = require('fs');
const path = require('path');
const cfgLib = require('./config');
const sched = require('./schedule');
const { runsDir, dataDir } = require('./store/paths');
const { themeStatus } = require('./store/tracker');

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

function publish(root, cfg, outDir, opts) {
  const out = path.resolve(root, outDir || 'site');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'api'), { recursive: true });
  fs.copyFileSync(path.join(root, 'ui', 'index.html'), path.join(out, 'index.html'));
  const data = dataDir(root, cfg);
  const issues = readJson(path.join(data, 'issues.json'), { items: {} });
  const state = {
    readOnly: true,
    envs: Object.keys(cfg.envs),
    themes: cfgLib.loadThemes(root),
    schedule: Object.assign({}, sched.loadSchedule(root), { description: sched.describe(sched.loadSchedule(root)) }),
    task: null,
    runs: readJson(path.join(data, 'runs.json'), []),
    issues,
    themeStatus: themeStatus(issues),
    checklist: cfgLib.loadChecklist(root).items.map((i) => ({ id: i.id, title: i.title, severity: i.severity })),
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out, 'api', 'state.json'), JSON.stringify(state));
  const files = copyTree(runsDir(root, cfg), path.join(out, 'runs'), (f) => !/_debug|current-run/.test(f) && (opts && opts.withVideos ? true : !/\.webm$/i.test(f)));
  return { out, runs: state.runs.length, files };
}

module.exports = { publish };
