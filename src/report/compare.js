// Flatten a run into rows, compare with the previous run, and group failures that share a cause.
const fs = require('fs');
const path = require('path');

const FAIL = (s) => s === 'fail' || s === 'error';

function flatten(run) {
  const rows = [];
  (run.themes || []).forEach((t) => {
    if (t.setupFailed) {
      rows.push({ theme: t.name, layout: 'setup', id: 'SETUP', status: 'fail', detail: `${t.setupFailed.reason || 'setup failed'}: ${t.setupFailed.detail || ''}`.trim(), shots: [] });
      return;
    }
    (t.passes || []).forEach((p) => p.results.forEach((r) => rows.push({ theme: t.name, layout: r.layout, viewport: p.viewport, id: r.id, status: r.status, detail: r.detail, shots: r.shots || [] })));
  });
  return rows;
}

const keyOf = (r) => `${r.theme}|${r.layout}|${r.id}`;

// Adds r.change = NEW | STILL | null to each row. FIXED rows come from the previous run and are returned separately.
function compare(rows, prevRows) {
  const prev = new Map((prevRows || []).map((r) => [keyOf(r), r]));
  const now = new Map(rows.map((r) => [keyOf(r), r]));
  rows.forEach((r) => {
    const p = prev.get(keyOf(r));
    r.change = null;
    if (!prevRows) return;
    if (FAIL(r.status)) r.change = p && FAIL(p.status) ? 'STILL' : 'NEW';
  });
  const fixed = [];
  if (prevRows) {
    prevRows.forEach((p) => {
      const n = now.get(keyOf(p));
      if (FAIL(p.status) && n && !FAIL(n.status) && n.status !== 'na') fixed.push(Object.assign({}, p, { change: 'FIXED', nowStatus: n.status }));
    });
  }
  return { rows, fixed };
}

// One shared issue = the same checklist id failing on several themes.
function groupIssues(rows, checklist) {
  const meta = new Map(checklist.items.map((i) => [i.id, i]));
  const g = new Map();
  rows.filter((r) => FAIL(r.status)).forEach((r) => {
    if (!g.has(r.id)) g.set(r.id, { id: r.id, title: (meta.get(r.id) || {}).title || r.id, severity: (meta.get(r.id) || {}).severity || 'major', themes: new Map() });
    const e = g.get(r.id);
    if (!e.themes.has(r.theme)) e.themes.set(r.theme, { theme: r.theme, layouts: new Set(), detail: r.detail, change: r.change });
    const t = e.themes.get(r.theme);
    t.layouts.add(r.layout);
    if (r.change === 'NEW') t.change = 'NEW';
  });
  const order = { critical: 0, major: 1, minor: 2 };
  return Array.from(g.values())
    .map((e) => ({ id: e.id, title: e.title, severity: e.severity, themes: Array.from(e.themes.values()).map((t) => ({ theme: t.theme, layouts: Array.from(t.layouts), detail: t.detail, change: t.change })) }))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.themes.length - a.themes.length);
}

function totals(rows) {
  const t = { pass: 0, fail: 0, na: 0, review: 0, error: 0 };
  rows.forEach((r) => { t[r.status] = (t[r.status] || 0) + 1; });
  return t;
}

// The newest earlier run of the same environment, if any.
function findPrevious(runsDir, env, currentId) {
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs.readdirSync(runsDir).filter((d) => d !== currentId && fs.existsSync(path.join(runsDir, d, 'results.json'))).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(runsDir, dirs[i], 'results.json'), 'utf8'));
      if (r.env === env) return r;
    } catch (e) { /* skip unreadable run */ }
  }
  return null;
}

module.exports = { flatten, compare, groupIssues, totals, findPrevious, FAIL };
