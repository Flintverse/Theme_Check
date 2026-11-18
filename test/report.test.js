// Comparison with the previous run, grouping by shared cause, the report and the mail.
const test = require('node:test');
const assert = require('node:assert');
const checklist = require('../checklist/checklist.json');
const { flatten, compare, groupIssues } = require('../src/report/compare');
const { render } = require('../src/report/html');
const { buildMail, sendMail } = require('../src/mail');

const mk = (runId, spec) => ({
  runId, env: 'staging', shop: 's.myshopify.com', startedAt: '2026-11-18T00:00:00Z',
  themes: Object.entries(spec).map(([name, results]) => ({ name, passes: [{ layout: 'vertical', viewport: 'desktop', video: null, results: results.map(([id, status, detail]) => ({ id, layout: 'vertical', status, detail: detail || '', shots: [] })) }] })),
});

const prev = mk('2026-11-11-staging', { Dawn: [['V-10', 'fail', 'no tick'], ['V-03', 'pass']], Craft: [['V-10', 'fail', 'no tick']], Rise: [['V-10', 'pass']] });
const now = mk('2026-11-18-staging', { Dawn: [['V-10', 'pass'], ['V-03', 'fail', 'count black on black']], Craft: [['V-10', 'fail', 'no tick']], Rise: [['V-10', 'fail', 'no tick']] });

test('compare marks NEW, STILL and FIXED', () => {
  const { rows, fixed } = compare(flatten(now), flatten(prev));
  const get = (t, id) => rows.find((r) => r.theme === t && r.id === id);
  assert.strictEqual(get('Dawn', 'V-03').change, 'NEW');
  assert.strictEqual(get('Craft', 'V-10').change, 'STILL');
  assert.strictEqual(get('Rise', 'V-10').change, 'NEW');
  assert.deepStrictEqual(fixed.map((r) => `${r.theme}/${r.id}`), ['Dawn/V-10']);
});

test('shared issues are grouped by checklist id', () => {
  const { rows } = compare(flatten(now), flatten(prev));
  const issues = groupIssues(rows, checklist);
  const v10 = issues.find((i) => i.id === 'V-10');
  assert.deepStrictEqual(v10.themes.map((t) => t.theme).sort(), ['Craft', 'Rise']);
  assert.strictEqual(issues[0].id, 'V-10', 'critical issues come first');
});

test('report shows totals, grouped issues, and failures first', () => {
  const html = render(now, checklist, prev);
  assert.match(html, /Found: 2 issue type/);
  assert.match(html, /count black on black/);
  assert.ok(html.indexOf('id="V-10"') < html.indexOf('id="G-01"') || !html.includes('id="G-01"'));
  assert.match(html, /class="chg NEW"/);
  assert.match(html, /Fixed since the previous run/);
});

test('a theme that failed to set up appears as a SETUP failure', () => {
  const run = { runId: 'r', env: 'staging', shop: 's', startedAt: 'x', themes: [{ name: 'Impulse', passes: [], setupFailed: { reason: 'not_in_findter_theme_list', detail: 'no Impulse' } }] };
  const html = render(run, checklist, null);
  assert.match(html, /Theme could not be set up/);
  assert.match(html, /not_in_findter_theme_list/);
});

test('mail subject and body summarise the run; dry send needs no password', async () => {
  const mail = buildMail(now, checklist, prev, {});
  assert.match(mail.subject, /staging: 2 issue type\(s\) on 3\/3 themes, 2 new/);
  assert.match(mail.html, /grouped by cause/);
  const res = await sendMail({ from: 'a@b.c', to: ['t@x.y'] }, mail, [{ filename: 'report.html' }], true);
  assert.strictEqual(res.dry, true);
  const saved = process.env.GMAIL_APP_PASSWORD;
  delete process.env.GMAIL_APP_PASSWORD;
  await assert.rejects(() => sendMail({ from: 'a@b.c', to: ['t@x.y'] }, mail, [], false), /GMAIL_APP_PASSWORD/);
  if (saved) process.env.GMAIL_APP_PASSWORD = saved;
});
