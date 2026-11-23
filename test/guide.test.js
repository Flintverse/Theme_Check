// The guide's code reference must name every test code of the checklist (so a new code cannot be added without saying what it means).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const checklist = require('../checklist/checklist.json');

const GUIDE = path.resolve(__dirname, '..', 'ui', 'guide.html');

test('guide: every test code has a row with its own severity, in the reference section', () => {
  const html = fs.readFileSync(GUIDE, 'utf8');
  const from = html.indexOf('<section id="codes">');
  const to = html.indexOf('</section>', from);
  assert.ok(from > 0 && to > from, 'the reference section exists');
  const sec = html.slice(from, to);
  const cls = { critical: 'p-fail', major: 'p-warn', minor: 'p-na' };
  for (const i of checklist.items) {
    const key = '<tr><td>' + i.id + '</td><td><span class="pill ' + cls[i.severity] + '">' + i.severity + '</span>';
    assert.ok(sec.includes(key), i.id + ' is missing from the guide, or its severity differs from the checklist (' + i.severity + ')');
  }
  ['PASS', 'FAIL', 'REVIEW', 'NA', 'SKIP', 'ERROR'].forEach((s) => assert.ok(sec.includes('>' + s + '</span>'), 'status ' + s + ' is explained'));
  ['not_in_findter_theme_list', 'save_not_persisted', 'findter_not_on_storefront', 'storefront_blocked', 'library_full', 'theme_is_live'].forEach((r) => assert.ok(sec.includes('<code>' + r + '</code>'), 'setup reason ' + r + ' is explained'));
});

test('guide: the reference opens from the top menu and shows its table', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file:///' + GUIDE.replace(/\\/g, '/'));
    await page.click('.top a[href="#codes"]');
    assert.ok(await page.isVisible('#codes'));
    assert.strictEqual(await page.locator('#codes table.codes tr').count() >= checklist.items.length, true);
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); }
});
