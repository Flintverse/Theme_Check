// Live progress of the run that is in progress: one small JSON file that the dashboard polls (and that is pushed to Cloudflare).
// Written by batch.js after every step; read by server.js. A crashed run is detected by its pid no longer being alive.
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 80;

function fileFor(dataDir) { return path.join(dataDir, 'progress.json'); }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class Progress {
  constructor(dataDir, init, onChange) {
    this.file = fileFor(dataDir);
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
    this.s.themes = list.map((t) => ({ name: t.name, batch: t.batch, status: 'queued', step: '', startedAt: null, finishedAt: null, fail: 0, pass: 0, review: 0 }));
    this.save();
  }

  theme(name) { return this.s.themes.find((t) => t.name === name); }

  // status: queued | installing | setup | testing | done | failed
  setTheme(name, patch) {
    const t = this.theme(name);
    if (!t) return;
    if (patch.status === 'setup' || patch.status === 'installing') t.startedAt = t.startedAt || new Date().toISOString();
    if (patch.status === 'done' || patch.status === 'failed') t.finishedAt = new Date().toISOString();
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
function readProgress(dataDir) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(fileFor(dataDir), 'utf8')); } catch (e) { return null; }
  if (s.running && !pidAlive(s.pid)) { s.running = false; s.outcome = 'stopped-unexpectedly'; s.phase = 'stopped'; }
  return withEta(s);
}

// Average time of finished themes x themes left. Only an estimate; null until one theme has finished.
function withEta(s) {
  const processed = s.themes.filter((t) => t.status === 'done' || t.status === 'failed'); // a theme that could not be set up is also finished
  const timed = processed.filter((t) => t.status === 'done' && t.startedAt && t.finishedAt); // only fully tested themes say how long one takes
  const left = s.themes.length - processed.length;
  s.counts = { total: s.themes.length, done: processed.length, left, failedSetup: s.themes.filter((t) => t.status === 'failed').length };
  if (timed.length && left && s.running) {
    const avg = timed.reduce((a, t) => a + (new Date(t.finishedAt) - new Date(t.startedAt)), 0) / timed.length;
    s.etaMinutes = Math.round((avg * left) / 60000);
  } else s.etaMinutes = null;
  return s;
}

module.exports = { Progress, readProgress, pidAlive, fileFor, withEta };
