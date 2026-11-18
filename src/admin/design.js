// Tab 1: Findter "Filter and grid design" page. Read / set the desktop Filter layout. Ported from the working theme-canary tool.
const { LoginRequired } = require('../lib/browser');

const LABEL = { vertical: 'Vertical', horizontal: 'Horizontal', offcanvas: 'Off-canvas' };

async function openDesign(ctx, env) {
  const page = await ctx.newPage();
  await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/apps/${env.appHandle}/design`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if (/accounts\.shopify\.com|\/login/.test(page.url())) { await page.close(); throw new LoginRequired(); }
  const frame = page.frameLocator('iframe[name="app-iframe"]');
  try {
    await frame.getByRole('checkbox', { name: 'Vertical' }).first().waitFor({ timeout: 60000 });
  } catch (e) {
    if (/accounts\.shopify\.com|\/login/.test(page.url())) throw new LoginRequired();
    throw new Error('Findter design page did not load (no layout checkboxes found).');
  }
  return { page, frame };
}

async function readLayout(frame) {
  for (const key of Object.keys(LABEL)) {
    // "Off-canvas" exists twice (Desktop, then Mobile): .first() is the Desktop one
    if (await frame.getByRole('checkbox', { name: LABEL[key] }).first().isChecked()) return key;
  }
  return null;
}

// Choose a layout, Save, then prove it persisted by reloading the page and reading it back.
async function setLayout(design, key) {
  const { page, frame } = design;
  const box = frame.getByRole('checkbox', { name: LABEL[key] }).first();
  if (!(await box.isChecked())) await box.click();
  const save = frame.locator('button:has-text("Save")').first();
  if (await save.isEnabled()) {
    await save.click();
    for (let i = 0; i < 30 && (await save.isEnabled()); i++) await page.waitForTimeout(500);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await frame.getByRole('checkbox', { name: 'Vertical' }).first().waitFor({ timeout: 60000 });
  const now = await readLayout(frame);
  if (now !== key) throw new Error(`Saved layout "${key}" but the page reads "${now}".`);
}

module.exports = { openDesign, readLayout, setLayout, LABEL };
