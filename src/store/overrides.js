// Manual verdicts. The script's own result (pass / fail / review / na) is never changed; a person can put a verdict on top of
// one check of one theme ("skip", "pass", "review" or "fail"), for example because a small error does not really matter, or
// because a "pass" turned out to be a fail when checked by hand. The reports, the numbers and the issue tracker use the verdict.
//
// File: <run folder>/overrides.json = { rev, items: { "<theme>|<layout>|<viewport>|<check id>": { status, orig, by, at } } }
// rev only ever goes up (milliseconds), so when two copies differ the one with the higher rev wins.
const fs = require('fs');
const path = require('path');

const VERDICTS = ['skip', 'pass', 'review', 'fail'];
const fileOf = (runDir) => path.join(runDir, 'overrides.json');
const empty = () => ({ rev: 0, items: {} });

function readOverrides(runDir) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(runDir), 'utf8'));
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return { rev: Number(j.rev) || 0, items: j.items };
  } catch (e) { /* none yet */ }
  return empty();
}

function writeOverrides(runDir, doc) {
  fs.mkdirSync(runDir, { recursive: true });
  const f = fileOf(runDir);
  fs.writeFileSync(f + '.tmp', JSON.stringify(doc, null, 2));
  fs.renameSync(f + '.tmp', f);
}

const keyFor = (theme, layout, viewport, id) => [theme, layout, viewport, id].join('|');

// Pure: the new document after one change. status null / '' removes the verdict (back to the script's result).
function withVerdict(doc, key, status, orig, who, now) {
  const d = { rev: Math.max(now || Date.now(), (doc.rev || 0) + 1), items: Object.assign({}, doc.items) };
  if (!status) delete d.items[key];
  else d.items[key] = { status, orig: String(orig || ''), by: String(who || ''), at: new Date(now || Date.now()).toISOString() };
  return d;
}

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 240 && key.split('|').length === 4 && !/[\u0000-\u001f<>]/.test(key);
}

// The status the rest of the code works with: skip counts as "not testable", the others are themselves.
const effective = (verdict) => (verdict === 'skip' ? 'na' : verdict);

// A copy of the run in which every check that has a verdict carries it (the original stays in r.autoStatus).
function applyOverrides(run, doc) {
  const items = doc && doc.items;
  if (!items || !Object.keys(items).length) return run;
  return Object.assign({}, run, {
    themes: (run.themes || []).map((t) => (t.passes ? Object.assign({}, t, {
      passes: t.passes.map((p) => Object.assign({}, p, {
        results: (p.results || []).map((r) => {
          const v = items[keyFor(t.name, p.layout, p.viewport, r.id)];
          return v && VERDICTS.includes(v.status) ? Object.assign({}, r, { status: effective(v.status), manual: v.status, autoStatus: r.status, manualBy: v.by }) : r;
        }),
      })),
    }) : t)),
  });
}

// Newer of two documents (for syncing the web copy and this machine).
const newer = (a, b) => ((a.rev || 0) >= (b.rev || 0) ? a : b);

module.exports = { VERDICTS, readOverrides, writeOverrides, keyFor, withVerdict, validKey, applyOverrides, effective, newer, empty };
