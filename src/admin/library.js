// Compare the themes a team wants tested with what the store's theme library actually holds.
const fs = require('fs');
const path = require('path');
const { norm } = require('../lib/browser');
const { dataDir } = require('../store/paths');

// wanted: [{name}], lib: [{id, name}] -> which wanted themes are in the store, which are missing, what else is there.
function compareLibrary(wanted, lib) {
  const byName = new Map();
  lib.forEach((t) => { const k = norm(t.name || ''); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(t.id); });
  const wantedKeys = new Set(wanted.map((t) => norm(t.name)));
  const present = [], missing = [];
  wanted.forEach((t) => {
    const ids = byName.get(norm(t.name));
    if (ids && ids.length) present.push({ name: t.name, ids }); else missing.push(t.name);
  });
  const extras = lib.filter((t) => !t.name || !wantedKeys.has(norm(t.name))).map((t) => ({ name: t.name || '(unnamed)', id: t.id }));
  const duplicates = present.filter((p) => p.ids.length > 1);
  return { present, missing, extras, duplicates };
}

function saveLibrary(root, cfg, envName, wanted, lib) {
  const cmp = compareLibrary(wanted, lib);
  const out = Object.assign({ env: envName, checkedAt: new Date().toISOString(), wanted: wanted.length, inStore: lib.length }, cmp);
  const dir = dataDir(root, cfg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `library-${envName}.json`), JSON.stringify(out, null, 2));
  return out;
}

function loadLibraries(root, cfg) {
  const dir = dataDir(root, cfg);
  const out = {};
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).filter((f) => /^library-.+\.json$/.test(f)).forEach((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); out[j.env] = j; } catch (e) { /* skip */ }
  });
  return out;
}

module.exports = { compareLibrary, saveLibrary, loadLibraries };
