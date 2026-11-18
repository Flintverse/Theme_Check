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

function queryTask() {
  if (process.platform !== 'win32') return { registered: false, note: 'Windows only' };
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST'], { encoding: 'utf8' });
  if (r.status !== 0) return { registered: false };
  const pick = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(r.stdout) || [])[1];
  return { registered: true, nextRun: pick('Next Run Time'), status: pick('Status'), lastRun: pick('Last Run Time'), lastResult: pick('Last Result') };
}

function saveSchedule(root, s) {
  fs.mkdirSync(path.dirname(fileFor(root)), { recursive: true });
  fs.writeFileSync(fileFor(root), JSON.stringify(s, null, 2));
}

module.exports = { launcherPath, writeLauncher, taskCommand, loadSchedule, saveSchedule, validate, describe, runCommand, schtasksArgs, applySchedule, removeSchedule, queryTask, DEFAULT, DAYS, TASK };
