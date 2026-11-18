// Cross-run issue tracker: for every (env, theme, layout, check) that ever failed, when it was first seen,
// when it was last seen failing, and on which check date it was found fixed (and whether it came back).
const { FAIL } = require('../report/compare');

const keyOf = (env, r) => `${env}|${r.theme}|${r.layout}|${r.id}`;

function emptyTracker() { return { updatedAt: null, items: {} }; }

// rows = flatten(run). Idempotent per runId, so re-finalising a run does not double count.
function updateTracker(tracker, run, rows, checklist) {
  const t = tracker && tracker.items ? tracker : emptyTracker();
  const meta = new Map(checklist.items.map((i) => [i.id, i]));
  const date = String(run.startedAt).slice(0, 10);
  rows.forEach((r) => {
    const key = keyOf(run.env, r);
    const failing = FAIL(r.status);
    let it = t.items[key];
    if (!it) {
      if (!failing) return; // only things that have failed at least once are tracked
      const m = meta.get(r.id) || {};
      it = t.items[key] = { env: run.env, theme: r.theme, layout: r.layout, id: r.id, title: m.title || (r.id === 'SETUP' ? 'Theme could not be set up' : r.id), severity: m.severity || 'major', status: 'open', firstSeen: date, firstRun: run.runId, lastSeen: date, lastRun: run.runId, fixedOn: null, fixedRun: null, reopened: 0, lastDetail: r.detail, history: [] };
    }
    if (it.history.some((h) => h.run === run.runId)) return;
    if (failing) {
      if (it.status === 'fixed') { it.status = 'open'; it.reopened += 1; it.fixedOn = null; it.fixedRun = null; }
      it.lastSeen = date; it.lastRun = run.runId; it.lastDetail = r.detail;
      it.evidence = { run: run.runId, shots: (r.shots || []).slice(0, 4) };
      it.history.push({ run: run.runId, date, s: 'fail' });
    } else if (r.status === 'pass') {
      if (it.status === 'open') { it.status = 'fixed'; it.fixedOn = date; it.fixedRun = run.runId; }
      it.history.push({ run: run.runId, date, s: 'pass' });
    } else {
      it.history.push({ run: run.runId, date, s: r.status }); // na / review: neither confirms nor clears the issue
    }
  });
  t.updatedAt = new Date().toISOString();
  return t;
}

// Per-theme roll-up for the UI.
function themeStatus(tracker) {
  const out = {};
  Object.values((tracker && tracker.items) || {}).forEach((it) => {
    const k = `${it.env}|${it.theme}`;
    out[k] = out[k] || { env: it.env, theme: it.theme, open: 0, fixed: 0 };
    out[k][it.status === 'open' ? 'open' : 'fixed'] += 1;
  });
  return Object.values(out);
}

module.exports = { updateTracker, emptyTracker, themeStatus, keyOf };
