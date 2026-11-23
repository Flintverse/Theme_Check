// Live progress of the run that is in progress: one small JSON file that the dashboard polls (and that is pushed to Cloudflare).
// Written by batch.js after every step; read by server.js. A crashed run is detected by its pid no longer being alive.
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 80;

// One file per environment, so runs on different stores can go on at the same time (progress-staging.json, progress-prod.json).
// progress.json is what older runs wrote; it is still read.
function fileFor(dataDir, env) { return path.join(dataDir, env ? `progress-${String(env).replace(/[^\w-]/g, '')}.json` : 'progress.json'); }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class Progress {
  constructor(dataDir, init, onChange) {
    this.file = fileFor(dataDir, init && init.env);
    this.onChange = onChange || null;
    this.s = Object.assign({
      running: true, outcome: null, pid: process.pid, runId: '', env: '', startedAt: new Date().toISOString(), updatedAt: null, finishedAt: null,
      phase: 'starting', step: '', current: null, themes: [], events: [], totals: { pass: 0, fail: 0, na: 0, review: 0 }, mode: 'background',
    }, init);
    this.save();
  }

  save() {
    this.s.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.s));
    fs.renameSync(tmp, this.file); // readers never see half a file
    if (this.onChange) { try { this.onChange(this.s); } catch (e) { /* monitoring must never break a run */ } }
  }

  event(msg) {
    this.s.events.push({ t: new Date().toISOString(), msg: String(msg).slice(0, 240) });
    if (this.s.events.length > MAX_EVENTS) this.s.events.splice(0, this.s.events.length - MAX_EVENTS);
    this.save();
  }

  setPhase(phase, step) { this.s.phase = phase; if (step !== undefined) this.s.step = step; this.save(); }

  setThemes(list) {
    this.s.themes = list.map((t) => ({ name: t.name, batch: t.batch, status: 'queued', step: '', startedAt: null, finishedAt: null, activeMs: 0, activeSince: null, fail: 0, pass: 0, review: 0 }));
    this.save();
  }

  theme(name) { return this.s.themes.find((t) => t.name === name); }

  // status: queued | installing | installed | preparing | setup | testing | done | failed
  // The Time column counts only 'setup' and 'testing': from the moment the theme editor is opened, never the installing / waiting.
  setTheme(name, patch) {
    const t = this.theme(name);
    if (!t) return;
    if (patch.status === 'setup' || patch.status === 'installing') t.startedAt = t.startedAt || new Date().toISOString();
    if (patch.status === 'done' || patch.status === 'failed') t.finishedAt = new Date().toISOString();
    // the Time column: only the time the theme is really being set up / tested, never the time it waits for its turn
    if (patch.status) {
      const active = patch.status === 'setup' || patch.status === 'testing';
      if (active && !t.activeSince) t.activeSince = new Date().toISOString();
      if (!active && t.activeSince) { t.activeMs = (t.activeMs || 0) + (Date.now() - new Date(t.activeSince).getTime()); t.activeSince = null; }
    }
    Object.assign(t, patch);
    this.s.current = patch.status === 'done' || patch.status === 'failed' ? (this.s.current && this.s.current.theme === name ? null : this.s.current) : { theme: name, status: t.status, step: t.step, since: new Date().toISOString() };
    this.save();
  }

  addResults(name, results) {
    const t = this.theme(name);
    results.forEach((r) => {
      const k = r.status === 'error' ? 'fail' : r.status;
      if (this.s.totals[k] !== undefined) this.s.totals[k] += 1;
      if (t && (k === 'fail' || k === 'pass' || k === 'review')) t[k] += 1;
    });
    this.save();
  }

  finish(outcome) {
    this.s.running = false;
    this.s.outcome = outcome;
    this.s.phase = outcome === 'completed' ? 'finished' : 'stopped';
    this.s.step = '';
    this.s.current = null;
    this.s.finishedAt = new Date().toISOString();
    this.save();
  }
}

// What the dashboard shows. A "running" file whose process is gone is reported as stalled.
function readFile(file) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  if (s.running && !pidAlive(s.pid)) { s.running = false; s.outcome = 'stopped-unexpectedly'; s.phase = 'stopped'; }
  return withEta(s);
}

// Every environment's latest run (progress-<env>.json and the older progress.json): running first, then the newest.
// When two files are about the same environment, the one that is running, or else the newer one, counts.
function readAllProgress(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir).filter((n) => /^progress(-[\w-]+)?\.json$/.test(n)); } catch (e) { return []; }
  const byEnv = new Map();
  for (const n of names) {
    const p = readFile(path.join(dataDir, n));
    if (!p) continue;
    const k = p.env || n;
    const old = byEnv.get(k);
    const better = !old || (p.running && !old.running) || (p.running === old.running && String(p.updatedAt) > String(old.updatedAt));
    if (better) byEnv.set(k, p);
  }
  // running ones first, the one that started first on top (a stable order: the page must not flip between two runs), then the newest
  return Array.from(byEnv.values()).sort((x, y) => (y.running ? 1 : 0) - (x.running ? 1 : 0) || (x.running && y.running ? String(x.startedAt).localeCompare(String(y.startedAt)) : String(y.updatedAt).localeCompare(String(x.updatedAt))));
}

// The one the page shows when nothing else is asked for: the one running (or the newest); with an env, that environment's.
function readProgress(dataDir, env) {
  const all = readAllProgress(dataDir);
  return (env ? all.find((p) => p.env === env) : all[0]) || null;
}

// Is a run going on in this environment right now (a live process)?
function envRunning(dataDir, env) { return readAllProgress(dataDir).some((p) => p.running && p.env === env); }

// Average time of finished themes x themes left. Only an estimate; null until one theme has finished.
function withEta(s) {
  const processed = s.themes.filter((t) => t.status === 'done' || t.status === 'failed'); // a theme that could not be set up is also finished
  const left = s.themes.length - processed.length;
  s.counts = { total: s.themes.length, done: processed.length, left, failedSetup: s.themes.filter((t) => t.status === 'failed').length };
  // wall-clock pace of the whole run (installs, waits and tests included), so the estimate stays honest
  if (processed.length && left && s.running) {
    const elapsed = Date.now() - new Date(s.startedAt).getTime();
    s.etaMinutes = Math.round((elapsed / processed.length * left) / 60000);
  } else s.etaMinutes = null;
  return s;
}

module.exports = { Progress, readProgress, readAllProgress, envRunning, pidAlive, fileFor, withEta };
