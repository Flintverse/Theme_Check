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
function installAgent(root) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  const p = launcherPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '@echo off\r\ncd /d "' + root + '"\r\n"' + process.execPath + '" src/cli.js agent >> history\\agent.log 2>&1\r\n');
  const tr = 'conhost.exe --headless "' + p + '"';
  const c = spawnSync('schtasks', ['/Create', '/F', '/TN', 'Theme check agent', '/SC', 'ONLOGON', '/TR', tr], { encoding: 'utf8' });
  if (c.status !== 0) return { ok: false, error: ((c.stderr || c.stdout) || 'schtasks failed').trim() };
  const r = spawnSync('schtasks', ['/Run', '/TN', 'Theme check agent'], { encoding: 'utf8' });
  return { ok: true, message: 'Installed. It starts at every logon' + (r.status === 0 ? ' and was started now.' : ' (start it once with: schtasks /Run /TN "Theme check agent").') };
}
function uninstallAgent() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  const r = spawnSync('schtasks', ['/Delete', '/F', '/TN', 'Theme check agent'], { encoding: 'utf8' });
  return { ok: r.status === 0 || /cannot find|does not exist/i.test(r.stderr || ''), message: 'Removed.' };
}

module.exports = { checkOnce, runAgent, installAgent, uninstallAgent, readRev, writeRev, revFile };
