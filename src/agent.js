// The agent: a small hidden process on the test machine. Every minute it looks at Cloudflare for a configuration saved on
// the web page; when there is a new one it validates it again here, writes it, applies it (Task Scheduler, GitHub) and
// reports back so the web page can show what happened. It also keeps the live progress of a run on the page (watch).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sched = require('./schedule');
const cfgLib = require('./config');
const sync = require('./sync');
const { propagate } = require('./propagate');

const revFile = (root) => path.join(root, 'config', '.applied-rev');
const readRev = (root) => { try { return Number(fs.readFileSync(revFile(root), 'utf8')) || 0; } catch (e) { return 0; } };
const writeRev = (root, rev) => { fs.mkdirSync(path.dirname(revFile(root)), { recursive: true }); fs.writeFileSync(revFile(root), String(rev)); };

async function getJson(monitor, p, fetchImpl) {
  const res = await (fetchImpl || fetch)(`${monitor.base}/api/ingest/${p}`, { headers: monitor.headers });
  if (!res.ok) throw new Error(`GET ${p}: HTTP ${res.status}`);
  return res.json();
}

// A process started before the variable was set (or by a tool) may not have it: read the Windows user variable.
function ensureToken() {
  if (process.env.THEME_CHECK_TOKEN || process.platform !== 'win32') return;
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'THEME_CHECK_TOKEN'], { encoding: 'utf8' });
  const m = /THEME_CHECK_TOKEN\s+REG_\w+\s+(\S+)/.exec(r.stdout || '');
  if (m) process.env.THEME_CHECK_TOKEN = m[1];
}

// One look at Cloudflare. Returns { changed, steps?, error? }.
async function checkOnce(root, cfg, opts) {
  const o = Object.assign({ fetchImpl: null, propagateFn: propagate }, opts || {});
  ensureToken();
  const monitor = sync.syncConfig(cfg);
  if (!monitor || monitor.error) return { changed: false, error: monitor ? monitor.error : 'no cloudflare section' };
  const remote = await getJson(monitor, 'config', o.fetchImpl);
  const applied = readRev(root);
  if (!remote.rev || remote.rev <= applied) return { changed: false };

  // validate again: whatever the page sent, only well-formed values reach the machine
  const status = { rev: remote.rev, at: new Date().toISOString(), steps: [] };
  const fail = async (msg) => {
    status.ok = false; status.steps = [{ step: 'Checked on the test machine', ok: false, detail: msg }];
    await sync.send(monitor, 'POST', 'config-status', JSON.stringify(status), null, o.fetchImpl).catch(() => {});
    writeRev(root, remote.rev); // do not retry the same bad configuration every minute
    return { changed: true, error: msg, steps: status.steps };
  };
  const what = { schedule: false, themes: false };
  if (remote.schedule) {
    const s = Object.assign({}, sched.DEFAULT, remote.schedule, { everyDays: Number(remote.schedule.everyDays) || 7, enabled: !!remote.schedule.enabled, mail: !!remote.schedule.mail });
    const err = sched.validate(s, Object.keys(cfg.envs));
    if (err.length) return fail(err.join('; '));
    sched.saveSchedule(root, s);
    what.schedule = true;
  }
  if (Array.isArray(remote.themes)) {
    const clean = cfgLib.cleanThemes(remote.themes);
    if (!clean.length) return fail('the theme list would be empty');
    cfgLib.saveThemes(root, clean);
    what.themes = true;
  }
  writeRev(root, remote.rev);
  const steps = await o.propagateFn(root, cfg, what, remote.updatedBy || 'the web page', { cloudConfig: false, fetchImpl: o.fetchImpl });
  status.steps = steps;
  status.ok = steps.every((x) => x.ok);
  await sync.send(monitor, 'POST', 'config-status', JSON.stringify(status), null, o.fetchImpl).catch(() => {});
  return { changed: true, steps };
}

const REPORT_SEEN = new Map(); // run id -> what was already uploaded (only changed pages go up)

// Manual verdicts (skip / pass / review / fail) set on the web page are kept in R2; the ones set in the local dashboard are
// on this machine. For the newest runs, the higher rev wins: a newer web copy is written here and the reports, the numbers
// and the issue tracker are recalculated; a newer local copy is sent up. Returns how many runs changed.
async function syncOverrides(root, cfg, opts) {
  const o = Object.assign({ fetchImpl: null, refresh: require('./store/archive').refreshRun, pushState: null }, opts);
  ensureToken();
  const monitor = sync.syncConfig(cfg);
  if (!monitor || monitor.error) return { changed: 0 };
  const ovr = require('./store/overrides');
  const { runsDir, dataDir } = require('./store/paths');
  const dir = runsDir(root, cfg);
  const ids = new Set();
  try { require('./store/progress').readAllProgress(dataDir(root, cfg)).forEach((p) => { if (p && p.runId) ids.add(p.runId); }); } catch (e) { /* no progress */ }
  try { fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'results.json'))).sort().slice(-3).forEach((d) => ids.add(d)); } catch (e) { /* no runs */ }
  let changed = 0;
  for (const runId of ids) {
    const runDir = path.join(dir, runId);
    if (!fs.existsSync(path.join(runDir, 'results.json'))) continue;
    const local = ovr.readOverrides(runDir);
    const remote = await getJson(monitor, 'overrides?run=' + encodeURIComponent(runId), o.fetchImpl);
    const rr = Number(remote.rev) || 0;
    if (rr === local.rev) continue;
    if (rr > local.rev) ovr.writeOverrides(runDir, { rev: rr, items: remote.items || {} });
    o.refresh({ root, cfg, runId, checklist: cfgLib.loadChecklist(root) });
    const files = ['overrides.json', 'summary.json'].concat(fs.readdirSync(runDir).filter((n) => /^report.*.html$/.test(n))).map((f) => path.join(runDir, f)).filter((f) => fs.existsSync(f));
    if (!REPORT_SEEN.has(runId)) REPORT_SEEN.set(runId, new Map());
    await sync.pushRunFiles(monitor, runDir, runId, { files, seen: REPORT_SEEN.get(runId), fetchImpl: o.fetchImpl });
    await (o.pushState ? o.pushState() : sync.pushState(monitor, require('./publish').buildState(root, cfg, { remote: true }), o.fetchImpl));
    changed++;
  }
  return { changed };
}

// A finished run whose report.html was written by an older version (no picture pop-up with an X) is drawn again with the
// current code and uploaded. A run that is still going is left alone: the live push draws its report in memory.
async function upgradeReports(root, cfg, opts) {
  const o = Object.assign({ fetchImpl: null, refresh: require('./store/archive').refreshRun }, opts);
  ensureToken();
  const monitor = sync.syncConfig(cfg);
  if (!monitor || monitor.error) return { upgraded: 0 };
  const { runsDir, dataDir } = require('./store/paths');
  const dir = runsDir(root, cfg);
  const going = new Set(); // every run that is still going (one per store)
  try { require('./store/progress').readAllProgress(dataDir(root, cfg)).forEach((p) => { if (p && p.running) going.add(p.runId); }); } catch (e) { /* none */ }
  let upgraded = 0;
  const ids = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((d) => fs.existsSync(path.join(dir, d, 'results.json'))).sort().slice(-3);
  for (const runId of ids) {
    if (going.has(runId)) continue;
    const rep = path.join(dir, runId, 'report.html');
    if (!fs.existsSync(rep) || fs.readFileSync(rep, 'utf8').includes('tc-report-v4')) continue;
    o.refresh({ root, cfg, runId, checklist: cfgLib.loadChecklist(root) });
    const pages = fs.readdirSync(path.join(dir, runId)).filter((n) => /^report.*.html$/.test(n)).map((n) => path.join(dir, runId, n));
    await sync.pushRunFiles(monitor, path.join(dir, runId), runId, { files: pages, fetchImpl: o.fetchImpl });
    upgraded++;
  }
  if (upgraded) await sync.pushState(monitor, require('./publish').buildState(root, cfg, { remote: true }), o.fetchImpl).catch(() => {}); // the run list now carries the theme names
  return { upgraded };
}

let SI_SIG = '', SI_AT = 0;
// The Schedule page's facts (saved settings, Windows task, what runs now, what waits) go up when they change, and at least every
// 90 seconds so the page can tell that the machine is alive.
async function syncScheduleInfo(root, cfg, opts) {
  const o = Object.assign({ fetchImpl: null, infoFn: null, force: false }, opts);
  ensureToken();
  const monitor = sync.syncConfig(cfg);
  if (!monitor || monitor.error) return { sent: false };
  const info = (o.infoFn || sched.info)(root, cfg);
  const sig = JSON.stringify(Object.assign({}, info, { at: '' }));
  if (!o.force && sig === SI_SIG && Date.now() - SI_AT < 90000) return { sent: false };
  await sync.send(monitor, 'POST', 'schedule-info', JSON.stringify(info), null, o.fetchImpl);
  SI_SIG = sig; SI_AT = Date.now();
  return { sent: true };
}

const RQ_SENT = new Map(); // request id -> what was last reported to the web page (only changes go up)
const rqSig = (r) => [r.status, r.note, r.runId, r.startedAt, r.finishedAt].join('|');

// "Run test" requests made on the web page: take the new ones, check them again here, cancel the ones that were cancelled,
// start what can start (one run per store; a busy store keeps its request queued), and report every change back.
// Returns { taken, rejected, cancelled, started, reported }.
async function syncRunRequests(root, cfg, opts) {
  const o = Object.assign({ fetchImpl: null, startDue: null }, opts);
  ensureToken();
  const monitor = sync.syncConfig(cfg);
  const q = require('./run-queue');
  const out = { taken: 0, rejected: 0, cancelled: 0, started: 0, reported: 0 };
  let remote = [];
  if (monitor && !monitor.error) { try { remote = (await getJson(monitor, 'run-requests', o.fetchImpl)).requests || []; } catch (e) { remote = []; } }
  const post = (doc) => sync.send(monitor, 'POST', 'run-requests/' + encodeURIComponent(doc.id), JSON.stringify(doc), null, o.fetchImpl).then(() => true, () => false);
  for (const r of remote) {
    if (!r || !/^[\w-]{1,40}$/.test(String(r.id || ''))) continue;
    const mine = q.get(root, r.id);
    if (!mine && r.status === 'requested') {
      const a = q.add(root, cfg, { env: r.env, browser: r.browser, themes: r.themes, tracker: r.tracker }, r.requestedBy, { id: r.id, requestedAt: r.requestedAt });
      if (a.ok) out.taken++;
      else if (!a.duplicate) { out.rejected++; await post(Object.assign({}, r, { status: 'rejected', note: a.error, finishedAt: new Date().toISOString() })); }
    } else if (mine && mine.status === 'queued' && r.cancelRequested) {
      if (q.cancel(root, r.id).ok) out.cancelled++;
    }
  }
  const started = (o.startDue || q.startDue)(root, cfg);
  out.started = started.length;
  if (monitor && !monitor.error) {
    for (const r of q.list(root).slice(-30)) {
      if (RQ_SENT.get(r.id) === rqSig(r)) continue;
      if (await post(q.publicView(r))) { RQ_SENT.set(r.id, rqSig(r)); out.reported++; }
    }
  }
  return out;
}

// Keeps checking, forever. The Windows task "Theme check agent" starts this at logon.
async function runAgent(root, cfg, log) {
  ensureToken();
  const say = log || ((m) => console.log('[' + require('./lib/time').fmtDateTime(new Date()) + ' UTC+7] ' + m));
  const lock = path.join(root, 'history', 'agent.pid');
  try {
    const old = Number(fs.readFileSync(lock, 'utf8'));
    if (old && old !== process.pid) { try { process.kill(old, 0); say('Another agent is already running (PID ' + old + '), exiting'); return; } catch (e) { /* stale lock */ } }
  } catch (e) { /* no lock */ }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  const monitor = require('./monitor');
  say('Agent started: checking Cloudflare for saved changes every minute');
  let last = 0, lastOv = 0;
  await monitor.watch(root, cfg, {
    everyMs: 15000,
    extraTick: async () => {
      try { // "Run test" requests: every tick (15 s)
        const r = await syncRunRequests(root, cfg);
        if (r.taken || r.rejected || r.cancelled || r.started) say('Run requests: ' + [r.taken && r.taken + ' new', r.rejected && r.rejected + ' rejected', r.cancelled && r.cancelled + ' cancelled', r.started && r.started + ' started'].filter(Boolean).join(', '));
      } catch (e) { say('Run requests failed: ' + e.message); }
      try { await syncScheduleInfo(root, cfg); } catch (e) { say('Schedule info failed: ' + e.message); }
      if (Date.now() - lastOv >= 30000) {
        lastOv = Date.now();
        try { const r = await syncOverrides(root, cfg); if (r.changed) say('Manual verdicts synced for ' + r.changed + ' run(s); reports and numbers recalculated'); } catch (e) { say('Verdict sync failed: ' + e.message); }
        try { const u = await upgradeReports(root, cfg); if (u.upgraded) say('Drew ' + u.upgraded + ' older report(s) again with the navigation bar and the picture X button'); } catch (e) { say('Report upgrade failed: ' + e.message); }
      }
      if (Date.now() - last < 60000) return;
      last = Date.now();
      try {
        const r = await checkOnce(root, cfg);
        if (r.changed) say('Applied a saved change: ' + (r.steps || []).map((s) => `${s.step}: ${s.ok ? 'ok' : 'FAILED ' + s.detail}`).join(' | '));
        else if (r.error) say('Check skipped: ' + r.error);
      } catch (e) { say('Check failed: ' + e.message); }
    },
  });
}

// "Theme check agent" as a Windows task that starts at logon (hidden), plus start it now.
function launcherPath(root) { return path.join(root, 'config', 'run-agent.cmd'); }
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function startNow(p) {
  const { spawn } = require('child_process');
  spawn('conhost.exe', ['--headless', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
function installAgent(root) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  const p = launcherPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.join(root, 'history'), { recursive: true });
  fs.writeFileSync(p, ['@echo off', 'cd /d "' + root + '"', '"' + process.execPath + '" src/cli.js agent >> history\\agent.log 2>&1', ''].join('\r\n'));
  const tr = 'conhost.exe --headless "' + p + '"';
  // 1) Task Scheduler at logon (needs administrator rights on most PCs)
  const c = spawnSync('schtasks', ['/Create', '/F', '/TN', 'Theme check agent', '/SC', 'ONLOGON', '/TR', tr], { encoding: 'utf8' });
  if (c.status === 0) {
    const r = spawnSync('schtasks', ['/Run', '/TN', 'Theme check agent'], { encoding: 'utf8' });
    return { ok: true, message: 'Installed (Task Scheduler). It starts at every logon' + (r.status === 0 ? ' and was started now.' : '.') };
  }
  // 2) no administrator rights: a per-user startup entry (HKCU Run), same effect
  const g = spawnSync('reg', ['add', RUN_KEY, '/v', 'ThemeCheckAgent', '/t', 'REG_SZ', '/d', tr, '/f'], { encoding: 'utf8' });
  if (g.status !== 0) return { ok: false, error: ((g.stderr || g.stdout) || c.stderr || 'could not install').trim() };
  try { startNow(p); } catch (e) { return { ok: true, message: 'Installed (startup entry). It starts at the next logon; could not start it now: ' + e.message }; }
  return { ok: true, message: 'Installed (per-user startup entry, no administrator rights needed). It starts at every logon and was started now.' };
}
function uninstallAgent() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  spawnSync('schtasks', ['/Delete', '/F', '/TN', 'Theme check agent'], { encoding: 'utf8' });
  spawnSync('reg', ['delete', RUN_KEY, '/v', 'ThemeCheckAgent', '/f'], { encoding: 'utf8' });
  return { ok: true, message: 'Removed from startup. A running agent stops at the next logoff (or end its node process).' };
}

module.exports = { checkOnce, syncOverrides, upgradeReports, syncRunRequests, syncScheduleInfo, runAgent, installAgent, uninstallAgent, readRev, writeRev, revFile };
