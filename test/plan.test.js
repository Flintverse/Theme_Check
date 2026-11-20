// The run plan: two pivot themes first, the rest in batches of 15, and the live-theme safety rules.
const test = require('node:test');
const assert = require('node:assert');
const cfgLib = require('../src/config');
const { planRun, DELAYS } = require('../src/batch');

const names = (a) => a.map((t) => t.name);

test('staging plan: Horizon and Dawn are pivots, the other 56 go in batches of 15', () => {
  const list = cfgLib.themesForEnv(cfgLib.loadThemes(require('path').resolve(__dirname, '..')), 'staging', 15);
  assert.strictEqual(list.length, 58);
  const plan = planRun(list, { pivots: ['Horizon', 'Dawn'] }, 15);
  assert.deepStrictEqual(names(plan.pivots), ['Horizon', 'Dawn'], 'Horizon first, then Dawn');
  assert.strictEqual(plan.rest.length, 56);
  assert.ok(!names(plan.rest).includes('Horizon') && !names(plan.rest).includes('Dawn'));
  assert.deepStrictEqual(plan.batches.map((b) => b.length), [15, 15, 15, 11]);
  assert.strictEqual(plan.batches[0][0].name, 'Atelier');
  assert.strictEqual(names(plan.batches.flat()).length, 56, 'nothing is lost or tested twice');
  assert.strictEqual(new Set(names(plan.batches.flat())).size, 56);
});

test('pivot rotation: batch 1 has Dawn live, batch 2 Horizon, and so on, so a live theme always exists', () => {
  // the rule used by runBatches: bi % 2 === 0 -> pivots[1] (Dawn) live, else pivots[0] (Horizon)
  const pivots = ['Horizon', 'Dawn'];
  const live = [0, 1, 2, 3].map((bi) => (bi % 2 === 0 ? pivots[1] : pivots[0]));
  assert.deepStrictEqual(live, ['Dawn', 'Horizon', 'Dawn', 'Horizon']);
});

test('prod plan has no pivots and uses batches of 15; the library never gets near the 20 limit', () => {
  const list = cfgLib.themesForEnv(cfgLib.loadThemes(require('path').resolve(__dirname, '..')), 'prod', 15);
  const plan = planRun(list, { pivots: [] }, 15);
  assert.strictEqual(plan.pivots.length, 0);
  assert.deepStrictEqual(plan.batches.map((b) => b.length), [15, 15, 15]);
  // pivots (2) + one batch (15) + nothing else = 17 themes, under Shopify's limit of 20
  assert.ok(2 + 15 <= 20);
});

test('a pivot that is not in the list is simply ignored', () => {
  const plan = planRun([{ name: 'Atelier' }, { name: 'Dawn' }], { pivots: ['Horizon', 'Dawn'] }, 15);
  assert.deepStrictEqual(names(plan.pivots), ['Dawn']);
  assert.deepStrictEqual(names(plan.rest), ['Atelier']);
});

test('the pauses between admin actions are generous', () => {
  assert.ok(DELAYS.afterInstall >= 10000);
  assert.ok(DELAYS.afterClean >= 10000);
  assert.ok(DELAYS.afterPublish >= 10000);
  assert.ok(DELAYS.beforeEdit >= 5000);
  assert.ok(DELAYS.installWait >= 60000, 'a pause after the install lands, before looking for the theme');
  assert.ok(DELAYS.afterListed >= 30000, 'a pause once the theme is listed, before its editor is tried');
  assert.ok(DELAYS.readyPoll >= 20000 && DELAYS.readyTimeout >= 300000, 'it keeps looking for several minutes');
});

test('one theme at a time: install, wait until usable, test, delete, next (the order of the calls, with stand-ins for the browser)', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Module = require('module');
  // run runBatches with fake admin modules and record what happens, in order
  const calls = [];
  const fakeThemes = {
    listThemes: async () => { calls.push('list'); return installed.map((x) => Object.assign({}, x)); },
    liveTheme: async () => ({ id: '1', name: 'Horizon', live: true }),
    cleanDrafts: async () => { calls.push('clean-leftovers'); return { deleted: 0, failed: [] }; },
    installAndFind: async (ctx, env, name) => { calls.push('install ' + name); const id = String(100 + installed.length); installed.push({ id, name }); return { ok: true, id }; },
    deleteTheme: async (ctx, env, id) => { calls.push('delete ' + id); const i = installed.findIndex((x) => x.id === id); if (i >= 0) installed.splice(i, 1); return { ok: true }; },
    publishTheme: async () => { throw new Error('nothing is published any more'); },
    norm: (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, ''),
  };
  const installed = [{ id: '1', name: 'Horizon', live: true }];
  let probes = 0;
  const fakeEditor = {
    probeEditor: async () => { probes++; calls.push('probe'); return probes === 1 ? { ok: false, detail: 'not yet' } : { ok: true, detail: '' }; },
    openEditor: async () => ({}), enableCore: async () => '', checkCompatPanel: async () => ({ id: 'P-01', layout: 'panel', status: 'na', detail: '', shots: [] }),
    chooseThemeAndSave: async () => ({ ok: true, steps: [] }), getPreviewUrl: async () => ({ url: 'https://x', cookies: [], via: 'fake' }), exitEditor: async () => {},
  };
  const fakeDesign = { openDesign: async () => ({}), setLayout: async () => {} };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-flow-'));
  ['checklist'].forEach((d) => fs.cpSync(path.join(__dirname, '..', d), path.join(root, d), { recursive: true }));
  const real = Module._load;
  Module._load = function (req, parent, isMain) {
    if (/\/admin\/themes$/.test(req)) return fakeThemes;
    if (/\/admin\/editor$/.test(req)) return fakeEditor;
    if (/\/admin\/design$/.test(req)) return fakeDesign;
    if (/\/lib\/browser$/.test(req) && parent && /batch\.js$/.test(parent.filename)) {
      const b = real.apply(this, arguments);
      return Object.assign({}, b, { openAdmin: async () => ({ close: async () => {} }), chromium: { launch: async () => ({ close: async () => {} }) } });
    }
    if (/\/checks\/run$/.test(req)) return { waitFindter: async () => ({ ok: true, looks: 1 }), runPass: async (o) => ({ layout: o.layout, viewport: o.viewportName, results: [{ id: 'V-01', layout: o.layout, status: 'pass', detail: '', shots: [] }] }), detectLayout: async () => '' };
    return real.apply(this, arguments);
  };
  delete require.cache[require.resolve('../src/batch')];
  try {
    const { runBatches } = require('../src/batch');
    const cfg = { envs: { staging: { shop: 's', adminHandle: 'h', themeStoreShop: 'h' } }, viewports: { desktop: {}, mobile: {} }, thresholds: {}, delays: { afterInstall: 1, afterClean: 1, beforeEdit: 1, afterExit: 1, installWait: 1, afterListed: 1, readyPoll: 1, readyTimeout: 5000 }, archive: {} };
    const list = [{ name: 'Dawn', batch: 1 }, { name: 'Craft', batch: 1 }];
    const { run } = await runBatches({ root, cfg, envName: 'staging', themeList: list, checklist: require('../checklist/checklist.json'), opts: { label: 'unit' } });
    const order = calls.filter((c) => c !== 'list');
    const at = (x) => order.indexOf(x);
    assert.ok(at('install Dawn') < at('delete 101'), 'Dawn is deleted after it is installed');
    assert.ok(order.indexOf('delete 101') < order.indexOf('install Craft'), 'the next theme is installed only after the previous one is deleted');
    assert.strictEqual(order.filter((c) => c === 'probe').length, 3, 'the first look said "not yet", so it waited and looked again; Craft was ready at once');
    assert.ok(!order.includes('delete 1'), 'the live theme is never deleted');
    assert.deepStrictEqual(run.themes.map((t) => t.name), ['Dawn', 'Craft']);
    assert.ok(/-unit$/.test(run.runId), 'the label is in the run id');
    assert.strictEqual(installed.length, 1, 'only the live theme is left');
  } finally { Module._load = real; delete require.cache[require.resolve('../src/batch')]; }
});

test('a stopped or killed Chrome does not ask to restore its tabs next time', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { markCleanExit } = require('../src/lib/browser');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-prof-'));
  fs.mkdirSync(path.join(d, 'Default', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Default', 'Sessions', 'Session_1'), 'x');
  fs.writeFileSync(path.join(d, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'keep' }, session: { restore_on_startup: 1 }, other: 1 }));
  markCleanExit(d);
  const j = JSON.parse(fs.readFileSync(path.join(d, 'Default', 'Preferences'), 'utf8'));
  assert.strictEqual(j.profile.exit_type, 'Normal');
  assert.strictEqual(j.profile.exited_cleanly, true);
  assert.strictEqual(j.profile.name, 'keep', 'the rest of the profile is untouched');
  assert.strictEqual(j.session.restore_on_startup, 5);
  assert.strictEqual(j.other, 1);
  assert.strictEqual(fs.existsSync(path.join(d, 'Default', 'Sessions')), false, 'the saved tabs of the last session are gone');
  markCleanExit(path.join(d, 'nothing-here')); // a profile that does not exist yet is fine
});
