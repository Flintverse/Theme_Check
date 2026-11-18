// Config, themes list and checklist loading, shared by the CLI and the UI server.
const fs = require('fs');
const path = require('path');

function loadConfig(root) {
  const local = path.join(root, 'config', 'config.local.json');
  const file = fs.existsSync(local) ? local : path.join(root, 'config', 'config.example.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg._file = path.basename(file);
  return cfg;
}

const loadChecklist = (root) => JSON.parse(fs.readFileSync(path.join(root, 'checklist', 'checklist.json'), 'utf8'));

const themesFile = (root) => path.join(root, 'config', 'themes.json');
function loadThemes(root) { return JSON.parse(fs.readFileSync(themesFile(root), 'utf8')).themes; }

// Names are what the Shopify Theme Store shows; keep them simple and unique (case-insensitive).
function cleanThemes(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach((t) => {
    const name = String(t.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || /[<>"\\]/.test(name) || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    const envs = Array.isArray(t.envs) ? Array.from(new Set(t.envs.filter((e) => /^[a-z0-9_-]{1,20}$/i.test(String(e))))) : ['staging', 'prod'];
    out.push({ name, envs: envs.length ? envs : ['staging', 'prod'], batch: Math.max(1, parseInt(t.batch, 10) || 1), enabled: t.enabled !== false });
  });
  return out;
}

function saveThemes(root, list) {
  const clean = cleanThemes(list);
  let note = '';
  try { note = JSON.parse(fs.readFileSync(themesFile(root), 'utf8')).note || ''; } catch (e) { /* none */ }
  fs.writeFileSync(themesFile(root), JSON.stringify({ note, themes: clean }, null, 2));
  return clean;
}

// Put the enabled themes into batches of `size` (the store holds at most 20 themes; the plan is 10 per batch).
function autoBatch(list, size) {
  let n = 0;
  return list.map((t) => (t.enabled === false ? Object.assign({}, t) : Object.assign({}, t, { batch: Math.floor(n++ / size) + 1 })));
}

// The themes to test in one environment, in list order, in batches of `size` (a store holds at most 20 themes).
function themesForEnv(list, env, size) {
  const picked = list.filter((t) => t.enabled !== false && (!t.envs || t.envs.includes(env)));
  return picked.map((t, i) => Object.assign({}, t, { batch: Math.floor(i / (size || 10)) + 1 }));
}

module.exports = { themesForEnv, loadConfig, loadChecklist, loadThemes, saveThemes, cleanThemes, autoBatch };
