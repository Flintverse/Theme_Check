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

// One look at Cloudflare. Returns { changed, steps?, error? }.
async function checkOnce(root, cfg, opts) {
  const o = Object.assign({ fetchImpl: null, propagateFn: propagate }, opts || {});
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

// Keeps checking, forever. The Windows task "Theme check agent" starts this at logon.
async function runAgent(root, cfg, log) {
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
  let last = 0;
  await monitor.watch(root, cfg, {
    everyMs: 15000,
    extraTick: async () => {
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

module.exports = { checkOnce, runAgent, installAgent, uninstallAgent, readRev, writeRev, revFile };
