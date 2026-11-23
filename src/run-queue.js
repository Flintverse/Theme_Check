// Run requests: "test these themes, on this store, in this browser". A request is chosen on the dashboard (web or local) and
// is started here as its own process with its own browser, so it never touches a run that is already going.
//
// One rule keeps results honest: ONE RUN PER STORE AT A TIME. Findter's layout is a store-wide setting and a run installs and
// deletes themes in the store, so two runs on the same store would change each other's layout and delete each other's theme.
// So: a request for a store that is free starts at once (in parallel with runs on other stores); a request for a store that is
// busy waits in the queue and starts by itself when that run ends. Nothing already running is ever stopped or disturbed.
//
// Requests live in history/queue/<id>.json:  status  queued -> running -> done | failed
//                                                    queued -> cancelled | rejected (with a reason)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfgLib = require('./config');
const { dataDir } = require('./store/paths');
const { readAllProgress, pidAlive } = require('./store/progress');
const T = require('./lib/time');

const BROWSERS = { chrome: 'Google Chrome', msedge: 'Microsoft Edge' };
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 &'.\-]{0,59}$/;
const ENV_OK = /^[\w-]{1,20}$/;
const MAX_THEMES = 80;
const FINAL = ['done', 'failed', 'cancelled', 'rejected'];

const queueDir = (root) => path.join(root, 'history', 'queue');
const fileOf = (root, id) => path.join(queueDir(root), id + '.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

function save(root, r) {
  fs.mkdirSync(queueDir(root), { recursive: true });
  const tmp = fileOf(root, r.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, fileOf(root, r.id));
  return r;
}

function list(root) {
  let names = [];
  try { names = fs.readdirSync(queueDir(root)).filter((n) => /\.json$/.test(n)); } catch (e) { return []; }
  return names.map((n) => readJson(path.join(queueDir(root), n), null)).filter(Boolean).sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

const get = (root, id) => readJson(fileOf(root, id), null);

// The profile folder that keeps the saved Shopify login of one store in one browser.
function profileFor(root, env, browser) {
  return path.join(root, browser === 'msedge' ? `.profile-${env}-msedge` : `.profile-${env}`);
}

// Validates what a person chose. Returns { ok, error } or { ok, request }.
function check(root, cfg, input) {
  const env = String((input && input.env) || '');
  const browser = String((input && input.browser) || 'chrome');
  if (!ENV_OK.test(env) || !cfg.envs[env]) return { ok: false, error: 'Unknown testing environment "' + env + '" (known: ' + Object.keys(cfg.envs).join(', ') + ').' };
  if (!BROWSERS[browser]) return { ok: false, error: 'Browser must be one of: ' + Object.keys(BROWSERS).join(', ') + '.' };
  const names = Array.isArray(input && input.themes) ? input.themes.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
  if (!names.length) return { ok: false, error: 'Choose at least one theme.' };
  if (names.length > MAX_THEMES) return { ok: false, error: 'At most ' + MAX_THEMES + ' themes in one run.' };
  const known = new Map(cfgLib.themesForEnv(cfgLib.loadThemes(root), env, cfg.batchSize || 15).map((t) => [t.name.toLowerCase(), t.name]));
  const picked = [];
  for (const n of names) {
    if (!NAME_OK.test(n)) return { ok: false, error: 'Not a valid theme name: ' + n.slice(0, 40) };
    const real = known.get(n.toLowerCase());
    if (!real) return { ok: false, error: '"' + n + '" is not in the ' + env + ' theme list (Themes tab).' };
    if (!picked.includes(real)) picked.push(real);
  }
  return { ok: true, env, browser, themes: picked, tracker: !!(input && input.tracker) };
}

// Is a run going on in this store right now? Looks at the live progress of every run (also runs started by the schedule or by
// hand) and at requests this queue started a moment ago, whose progress file is not there yet.
function envBusy(root, cfg, env) {
  if (readAllProgress(dataDir(root, cfg)).some((p) => p.running && p.env === env)) return true;
  return list(root).some((r) => r.status === 'running' && r.env === env && pidAlive(r.pid));
}

// opts.id: keep the id the web page gave (so both sides talk about the same request); opts.requestedAt likewise.
function add(root, cfg, input, who, opts) {
  const c = check(root, cfg, input);
  if (!c.ok) return c;
  const now = new Date();
  const id = (opts && opts.id) || T.today().replace(/-/g, '') + '-' + T.fmtTime(now).replace(/:/g, '') + '-' + Math.random().toString(36).slice(2, 5);
  if (!/^[\w-]{1,40}$/.test(id)) return { ok: false, error: 'bad request id' };
  if (get(root, id)) return { ok: false, error: 'This request is already known.', duplicate: true };
  const r = save(root, {
    id, env: c.env, browser: c.browser, themes: c.themes, tracker: c.tracker,
    label: 'manual-' + T.fmtTime(now).replace(/:/g, ''),
    requestedBy: String(who || 'the dashboard').slice(0, 80), requestedAt: (opts && opts.requestedAt) || now.toISOString(),
    status: 'queued', note: '', runId: '', pid: 0, startedAt: null, finishedAt: null,
  });
  return { ok: true, request: r };
}

function reject(root, r, reason) { r.status = 'rejected'; r.note = reason; r.finishedAt = new Date().toISOString(); return save(root, r); }

function cancel(root, id) {
  const r = get(root, id);
  if (!r) return { ok: false, error: 'No such request.' };
  if (r.status !== 'queued') return { ok: false, error: r.status === 'running' ? 'It is already running. A run in progress is never stopped from here.' : 'It is already ' + r.status + '.' };
  r.status = 'cancelled'; r.finishedAt = new Date().toISOString(); r.note = 'Cancelled before it started.';
  save(root, r);
  return { ok: true, request: r };
}

// Running requests whose process is gone are finished: done when the run completed, failed otherwise.
function reconcile(root, cfg) {
  const changed = [];
  const prog = readAllProgress(dataDir(root, cfg));
  for (const r of list(root)) {
    if (r.status !== 'running') continue;
    const p = prog.find((x) => x.env === r.env && String(x.runId || '').endsWith('-' + r.label));
    if (p && !r.runId) r.runId = p.runId;
    if (pidAlive(r.pid)) { if (p && r.runId) save(root, r); continue; }
    r.status = p && p.outcome === 'completed' ? 'done' : 'failed';
    if (p && p.outcome && p.outcome !== 'completed') r.note = 'The run ended: ' + p.outcome + '.';
    if (!p) r.note = r.note || 'The run process ended before it reported any progress. See history/queue/' + r.id + '.log';
    r.finishedAt = new Date().toISOString();
    save(root, r); changed.push(r);
  }
  return changed;
}

// The command that runs one request (an array: never passed through a shell).
function runArgs(root, r) {
  const a = [path.join(root, 'src', 'cli.js'), 'run', '--env', r.env, '--themes', r.themes.join(','), '--label', r.label, '--keep-pictures', '--browser', r.browser];
  if (!r.tracker) a.push('--no-tracker');
  return a;
}

// Starts every queued request whose store is free (oldest first, one per store). `spawnFn` is injectable for tests.
function startDue(root, cfg, opts) {
  const o = Object.assign({ spawnFn: null }, opts);
  reconcile(root, cfg);
  const started = [];
  const takenNow = new Set();
  for (const r of list(root)) {
    if (r.status !== 'queued') continue;
    if (takenNow.has(r.env) || envBusy(root, cfg, r.env)) { // wait for the run in this store; nothing is interrupted
      const why = 'Waiting: another run is going on in the ' + r.env + ' store. It starts by itself when that run ends.';
      if (r.note !== why) { r.note = why; save(root, r); }
      continue;
    }
    // a saved login must exist for this store in this browser, else the run could only fail
    if (!fs.existsSync(profileFor(root, r.env, r.browser))) {
      reject(root, r, 'No saved Shopify login for ' + r.env + ' in ' + BROWSERS[r.browser] + '. Log in once on the test machine: node src/cli.js login --env ' + r.env + (r.browser === 'msedge' ? ' --browser msedge' : ''));
      continue;
    }
    // two processes (the agent and the local dashboard) may both look: only the one that creates the claim file starts it
    const claim = fileOf(root, r.id).replace(/\.json$/, '.claim');
    try { fs.closeSync(fs.openSync(claim, 'wx')); } catch (e) { continue; }
    const args = runArgs(root, r);
    let pid = 0;
    try {
      if (o.spawnFn) pid = o.spawnFn(process.execPath, args, r);
      else {
        const log = fs.openSync(path.join(queueDir(root), r.id + '.log'), 'w');
        const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true });
        pid = child.pid;
        child.unref();
      }
    } catch (e) { reject(root, r, 'Could not start the run: ' + e.message); continue; }
    r.status = 'running'; r.pid = pid; r.startedAt = new Date().toISOString(); r.note = '';
    save(root, r);
    takenNow.add(r.env);
    started.push(r);
  }
  return started;
}

// What the pages show: the request without anything private.
function publicView(r) {
  return { id: r.id, env: r.env, browser: r.browser, themes: r.themes, status: r.status, note: r.note || '', runId: r.runId || '', requestedBy: r.requestedBy, requestedAt: r.requestedAt, startedAt: r.startedAt, finishedAt: r.finishedAt, tracker: !!r.tracker };
}

module.exports = { BROWSERS, FINAL, MAX_THEMES, queueDir, profileFor, check, add, cancel, get, list, save, reject, reconcile, startDue, envBusy, runArgs, publicView };
