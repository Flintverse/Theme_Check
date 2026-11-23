// Schedule: daily, weekly, or every N days. Stored in config/schedule.json and, on request, registered as a Windows scheduled task.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TASK = 'Theme check';
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DEFAULT = { enabled: false, mode: 'weekly', time: '07:30', weekday: 'MON', everyDays: 7, env: 'staging', batches: 'all', mail: true };

const fileFor = (root) => path.join(root, 'config', 'schedule.json');
function loadSchedule(root) {
  try { return Object.assign({}, DEFAULT, JSON.parse(fs.readFileSync(fileFor(root), 'utf8'))); } catch (e) { return Object.assign({}, DEFAULT); }
}

// Validate before anything reaches the scheduler: the values end up in a command line.
function validate(s, envNames) {
  const e = [];
  if (!['daily', 'weekly', 'everyNDays'].includes(s.mode)) e.push('mode must be daily, weekly or everyNDays');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time))) e.push('time must be HH:MM (24 hour)');
  if (s.mode === 'weekly' && !DAYS.includes(s.weekday)) e.push('weekday must be one of ' + DAYS.join(', '));
  if (s.mode === 'everyNDays' && !(Number.isInteger(Number(s.everyDays)) && Number(s.everyDays) >= 1 && Number(s.everyDays) <= 90)) e.push('everyDays must be a whole number from 1 to 90');
  if (envNames && !envNames.includes(s.env)) e.push('env must be one of ' + envNames.join(', '));
  if (!(s.batches === 'all' || /^\d+(,\d+)*$/.test(String(s.batches)))) e.push('batches must be "all" or numbers like 1,2,3');
  return e;
}

function describe(s) {
  if (!s.enabled) return 'Off (no automatic runs).';
  const at = `at ${s.time}`;
  if (s.mode === 'daily') return `Every day ${at}`;
  if (s.mode === 'weekly') return `Every week on ${s.weekday} ${at}`;
  return `Every ${s.everyDays} days ${at}`;
}

// The command the task runs.
function runCommand(s, root, nodePath) {
  const b = s.batches === 'all' ? '' : ` --batches ${s.batches}`;
  return `cmd /c cd /d "${root}" && "${nodePath || process.execPath}" src/cli.js run --env ${s.env}${b}${s.mail ? ' --mail' : ''} >> history\\scheduler.log 2>&1`;
}

// schtasks arguments (passed as an array, never through a shell string).
function schtasksArgs(s, root, nodePath) {
  const a = ['/Create', '/F', '/TN', TASK, '/TR', runCommand(s, root, nodePath), '/ST', s.time];
  if (s.mode === 'daily') a.push('/SC', 'DAILY');
  else if (s.mode === 'weekly') a.push('/SC', 'WEEKLY', '/D', s.weekday);
  else a.push('/SC', 'DAILY', '/MO', String(Number(s.everyDays)));
  return a;
}

// The task runs a small .cmd through conhost --headless, so no console window appears while the person works.
function launcherPath(root) { return path.join(root, 'config', 'run-scheduled.cmd'); }
function writeLauncher(s, root, nodePath) {
  const p = launcherPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '@echo off\r\n' + 'cd /d "' + root + '"\r\n' + '"' + (nodePath || process.execPath) + '" src/cli.js run --env ' + s.env + (s.batches === 'all' ? '' : ' --batches ' + s.batches) + (s.mail ? ' --mail' : '') + ' >> history\\scheduler.log 2>&1\r\n');
  return p;
}
function taskCommand(root) { return 'conhost.exe --headless "' + launcherPath(root) + '"'; }

function applySchedule(s, root, envNames) {
  const err = validate(s, envNames);
  if (err.length) return { ok: false, error: err.join('; ') };
  if (process.platform !== 'win32') return { ok: false, error: 'Registering a task works on Windows (Task Scheduler). On another OS use cron with the same command.', command: runCommand(s, root) };
  if (!s.enabled) return removeSchedule();
  writeLauncher(s, root);
  const args = schtasksArgs(s, root);
  args[args.indexOf('/TR') + 1] = taskCommand(root);
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return r.status === 0 ? { ok: true, message: (r.stdout || '').trim() } : { ok: false, error: ((r.stderr || r.stdout) || 'schtasks failed').trim() };
}

function removeSchedule() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  const r = spawnSync('schtasks', ['/Delete', '/F', '/TN', TASK], { encoding: 'utf8' });
  return r.status === 0 || /cannot find|does not exist/i.test(r.stderr || '') ? { ok: true, message: 'Task removed (or was not there).' } : { ok: false, error: (r.stderr || '').trim() };
}

function queryTask(name) {
  if (process.platform !== 'win32') return { registered: false, note: 'Windows only' };
  const r = spawnSync('schtasks', ['/Query', '/TN', name || TASK, '/V', '/FO', 'LIST'], { encoding: 'utf8' });
  if (r.status !== 0) return { registered: false };
  const pick = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(r.stdout) || [])[1];
  return { registered: true, nextRun: pick('Next Run Time'), status: pick('Status'), lastRun: pick('Last Run Time'), lastResult: pick('Last Result'), command: pick('Task To Run') };
}

// "11/26/2026 9:00:00 AM" (what schtasks prints on this PC) or "26/11/2026 09:00:00" -> "2026-11-26 09:00". The PC's clock is UTC+7
// (README), so the text is already in the time the dashboard uses. Anything else (N/A, a task that never ran) -> null.
function parseTaskTime(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  let a = +m[1], b = +m[2], h = +m[4];
  const [month, day] = a > 12 ? [b, a] : [a, b]; // US month/day, or day/month when the first number cannot be a month
  if (m[6]) { h = h % 12 + (/pm/i.test(m[6]) ? 12 : 0); }
  if (+m[3] < 2001) return null; // 11/30/1999: Windows' "never ran"
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(month)}-${p(day)} ${p(h)}:${m[5]}`;
}

// What the registered task will really run (from the launcher file the task starts): the store, the batches, the mail.
function registeredFor(root) {
  try {
    const txt = fs.readFileSync(launcherPath(root), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => /cli\.js run /.test(l));
    if (!line) return null;
    return { env: (/--env (\S+)/.exec(line) || [])[1] || '', batches: (/--batches (\S+)/.exec(line) || [])[1] || 'all', mail: /--mail\b/.test(line) };
  } catch (e) { return null; }
}

// Everything the Schedule page shows: the saved settings, the Windows task (next / last run), whether the two agree, what is running
// now and what waits. `queryFn` / `progress` / `queue` are injectable for tests.
function info(root, cfg, opts) {
  const o = Object.assign({ queryFn: queryTask, progress: null, queue: null }, opts);
  const saved = Object.assign({}, loadSchedule(root));
  saved.description = describe(saved);
  const t = o.queryFn() || { registered: false };
  const task = { registered: !!t.registered, status: t.status || '', nextRun: parseTaskTime(t.nextRun), lastRun: parseTaskTime(t.lastRun), lastResult: t.lastResult === undefined ? '' : String(t.lastResult), runs: t.registered ? registeredFor(root) : null };
  const drift = [];
  if (saved.enabled && !task.registered) drift.push('The schedule is saved as On, but no Windows task is registered, so nothing will start by itself. Press Save schedule to register it.');
  if (!saved.enabled && task.registered) drift.push('The schedule is saved as Off, but a Windows task is still registered (next run ' + (task.nextRun || '?') + '). Press Turn off to remove it.');
  if (saved.enabled && task.registered && task.runs) {
    const diff = [];
    if (task.runs.env && task.runs.env !== saved.env) diff.push('store ' + task.runs.env + ' (saved: ' + saved.env + ')');
    if (task.runs.batches !== String(saved.batches)) diff.push('batches ' + task.runs.batches + ' (saved: ' + saved.batches + ')');
    if (task.runs.mail !== !!saved.mail) diff.push('mail ' + (task.runs.mail ? 'yes' : 'no') + ' (saved: ' + (saved.mail ? 'yes' : 'no') + ')');
    if (diff.length) drift.push('The registered task does not match the saved settings: it runs ' + diff.join(', ') + '. Press Save schedule to apply the saved settings.');
  }
  const prog = o.progress || (() => { try { return require('./store/progress').readAllProgress(require('./store/paths').dataDir(root, cfg)); } catch (e) { return []; } })();
  const running = prog.filter((p) => p.running).map((p) => ({ env: p.env, runId: p.runId, startedAt: p.startedAt, done: (p.counts && p.counts.done) || 0, total: (p.counts && p.counts.total) || (p.themes || []).length, current: p.current ? p.current.theme + (p.current.step ? ' - ' + p.current.step : '') : (p.step || p.phase || '') }));
  const queue = o.queue || (() => { try { return require('./run-queue').list(root); } catch (e) { return []; } })();
  const queued = queue.filter((r) => r.status === 'queued').map((r) => ({ id: r.id, env: r.env, themes: (r.themes || []).length, requestedBy: r.requestedBy, requestedAt: r.requestedAt }));
  return { at: new Date().toISOString(), saved, task, inSync: drift.length === 0, drift, running, queued };
}

function saveSchedule(root, s) {
  fs.mkdirSync(path.dirname(fileFor(root)), { recursive: true });
  fs.writeFileSync(fileFor(root), JSON.stringify(s, null, 2));
}

module.exports = { launcherPath, writeLauncher, taskCommand, loadSchedule, saveSchedule, validate, describe, runCommand, schtasksArgs, applySchedule, removeSchedule, queryTask, parseTaskTime, registeredFor, info, DEFAULT, DAYS, TASK };
