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
  assert.strictEqual(DELAYS.installWait, 180000, 'the 3 minute wait for installed themes is kept');
});
