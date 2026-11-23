// The Findter design page: a layout click that the page wipes (it redraws when the plan notice arrives) is retried after a reload.
const test = require('node:test');
const assert = require('node:assert');
const design = require('../src/admin/design');

function fake({ wipes }) {
  const st = { layout: 'vertical', pending: null, saveVisible: false, clicks: 0, reloads: 0 };
  const cb = (label) => ({
    first() { return this; },
    isChecked: async () => (st.pending || st.layout) === label.toLowerCase().replace('-', ''),
    click: async () => { st.clicks++; if (st.clicks > wipes) { st.pending = label.toLowerCase().replace('-', ''); st.saveVisible = true; } },
    waitFor: async () => {},
    boundingBox: async () => ({ y: 400 }),
  });
  const saveBtn = { click: async () => { st.layout = st.pending; st.pending = null; st.saveVisible = false; }, count: async () => (st.saveVisible ? 1 : 0), isEnabled: async () => false };
  const frame = {
    getByRole: (role, o) => (role === 'checkbox' ? cb(o.name) : { count: async () => 0, first: () => saveBtn }),
    locator: () => ({ innerText: async () => 'Store limit reached\nYour catalog exceeds the free plan limit.' }),
  };
  const page = {
    getByRole: () => ({ count: async () => (st.saveVisible ? 1 : 0), first: () => saveBtn }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, screenshot: async () => {},
    reload: async () => { st.reloads++; st.pending = null; st.saveVisible = false; },
  };
  return { st, d: { page, frame, shotDir: null } };
}

test('design: a click that is wiped is retried after a reload and then saved', async () => {
  const { st, d } = fake({ wipes: 1 });
  await design.setLayout(d, 'horizontal');
  assert.strictEqual(st.layout, 'horizontal');
  assert.strictEqual(st.clicks, 2);
  assert.ok(st.reloads >= 2);
});

test('design: when Save never appears the error says so, with the plan notice the page shows', async () => {
  const { d } = fake({ wipes: 99 });
  await assert.rejects(() => design.setLayout(d, 'horizontal'), (e) => /no Save button appeared/.test(e.message) && /Store limit reached/.test(e.message));
});

test('design: readNotice returns the plan notice, or nothing', async () => {
  assert.match(await design.readNotice({ locator: () => ({ innerText: async () => 'Store limit reached\nUpgrade now' }) }), /Store limit reached/);
  assert.strictEqual(await design.readNotice({ locator: () => ({ innerText: async () => 'Filter layout' }) }), '');
});
