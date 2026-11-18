// Local UI server: manage themes and the schedule, start a run, browse history and the issue tracker.
// Listens on 127.0.0.1 only. There is no login, so do not expose the port; to share results use `publish` (read-only copy).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const cfgLib = require('./config');
const sched = require('./schedule');
const { archiveRoot, runsDir, dataDir } = require('./store/paths');
const { themeStatus } = require('./store/tracker');
const { readProgress } = require('./store/progress');
const { loadLibraries } = require('./admin/library');

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

function createServer(root, opts) {
  const o = Object.assign({ spawnRun: true }, opts);
  const uiDir = path.join(root, 'ui');
  let current = null; // { pid, startedAt, args, logFile, child }
  // after a save: Task Scheduler + Cloudflare + GitHub follow (injectable, so tests never touch the real machine)
  const propagate = o.propagate || ((r, c, what, who) => require('./propagate').propagate(r, c, what, who));

  const state = () => {
    const cfg = cfgLib.loadConfig(root);
    const data = dataDir(root, cfg);
    return {
      readOnly: false,
      mediaLocal: true,
      evidenceUrl: (cfg.evidence && cfg.evidence.driveUrl) || '',
      envs: Object.keys(cfg.envs),
      themes: cfgLib.loadThemes(root),
      schedule: Object.assign({}, sched.loadSchedule(root), { description: sched.describe(sched.loadSchedule(root)) }),
      task: sched.queryTask(),
      runs: readJson(path.join(data, 'runs.json'), []),
      issues: readJson(path.join(data, 'issues.json'), { items: {} }),
      themeStatus: themeStatus(readJson(path.join(data, 'issues.json'), { items: {} })),
      library: loadLibraries(root, cfg),
      checklist: cfgLib.loadChecklist(root).items.map((i) => ({ id: i.id, title: i.title, severity: i.severity })),
      archiveDir: archiveRoot(root, cfg),
      running: current ? { startedAt: current.startedAt, args: current.args } : null,
    };
  };

  const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('invalid JSON')); } }); });

  function serveFile(res, base, rel) {
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, { error: 'forbidden' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(file).pipe(res);
    });
  }

  function startRun(body, cfg) {
    if (current) return { ok: false, error: 'A run is already in progress.' };
    const env = body.env || 'staging';
    if (!cfg.envs[env]) return { ok: false, error: 'Unknown env.' };
    const batches = body.batches && body.batches !== 'all' ? String(body.batches) : '';
    if (batches && !/^\d+(,\d+)*$/.test(batches)) return { ok: false, error: 'batches must be like 1,2,3' };
    const args = [path.join(root, 'src', 'cli.js'), 'run', '--env', env];
    if (batches) args.push('--batches', batches);
    if (body.mail) args.push('--mail');
    if (body.show) args.push('--show');
    if (!o.spawnRun) return { ok: true, dry: true, args };
    const logFile = path.join(archiveRoot(root, cfg), 'data', 'current-run.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', out, out], windowsHide: true });
    current = { startedAt: new Date().toISOString(), args: args.slice(2).join(' '), logFile, child };
    child.on('exit', (code) => { fs.appendFileSync(logFile, `\n[finished, exit code ${code}]\n`); current = null; });
    return { ok: true, started: current.args };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      const cfg = cfgLib.loadConfig(root);
      if (req.method !== 'GET') {
        // a page on another site must not be able to change settings: require our own header and a local origin
        const origin = req.headers.origin;
        if (req.headers['x-tc'] !== '1' || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) return send(res, 403, { error: 'forbidden' });
      }
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, state());
      if (req.method === 'GET' && p === '/api/progress') return send(res, 200, readProgress(dataDir(root, cfg)) || { running: false, none: true });
      if (req.method === 'GET' && p === '/api/run-log') {
        const f = path.join(dataDir(root, cfg), 'current-run.log');
        const txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').slice(-60).join('\n') : '';
        return send(res, 200, { running: !!current, log: txt });
      }
      if (req.method === 'PUT' && p === '/api/themes') {
        const body = await readBody(req);
        if (!Array.isArray(body.themes)) return send(res, 400, { error: 'themes must be a list' });
        const list = body.autoBatch ? cfgLib.autoBatch(cfgLib.cleanThemes(body.themes), Number(body.autoBatch) || 10) : body.themes;
        const saved = cfgLib.saveThemes(root, list);
        return send(res, 200, { themes: saved, steps: await propagate(root, cfg, { themes: true }, 'the dashboard on the test machine') });
      }
      if (req.method === 'PUT' && p === '/api/schedule') {
        const body = await readBody(req);
        const s = Object.assign({}, sched.DEFAULT, body, { everyDays: Number(body.everyDays) || 7, enabled: !!body.enabled, mail: !!body.mail });
        const err = sched.validate(s, Object.keys(cfg.envs));
        if (err.length) return send(res, 400, { error: err.join('; ') });
        sched.saveSchedule(root, s);
        return send(res, 200, { schedule: s, description: sched.describe(s), command: sched.runCommand(s, root), steps: await propagate(root, cfg, { schedule: true }, 'the dashboard on the test machine') });
      }
      if (req.method === 'POST' && p === '/api/schedule/apply') {
        const s = sched.loadSchedule(root);
        return send(res, 200, sched.applySchedule(s, root, Object.keys(cfg.envs)));
      }
      if (req.method === 'POST' && p === '/api/schedule/remove') return send(res, 200, sched.removeSchedule());
      if (req.method === 'POST' && p === '/api/run') {
        const r = startRun(await readBody(req), cfg);
        return send(res, r.ok ? 200 : 409, r);
      }
      if (req.method === 'GET' && p.startsWith('/runs/')) return serveFile(res, runsDir(root, cfg), p.slice(6));
      if (req.method === 'GET') return serveFile(res, uiDir, p === '/' ? 'index.html' : p.slice(1));
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String(e.message).slice(0, 200) });
    }
  });
  server.stopRun = () => { if (current && current.child) current.child.kill(); };
  return server;
}

function listen(root, port, opts) {
  const server = createServer(root, opts);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { createServer, listen };
