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

// The Save button is inside the app frame on some builds and in the Shopify admin's own top save bar on others
// (the staging app). Look in both. No Save button after a click means nothing changed (the layout was already set).
async function findSave(page, frame) {
  for (let i = 0; i < 12; i++) {
    const inFrame = frame.getByRole('button', { name: 'Save', exact: true });
    if ((await inFrame.count()) > 0) return inFrame.first();
    const top = page.getByRole('button', { name: 'Save', exact: true });
    if ((await top.count()) > 0) return top.first();
    await page.waitForTimeout(500);
  }
  return null;
}

// Choose a layout, Save, then prove it persisted by reloading the page and reading it back.
async function setLayout(design, key) {
  const { page, frame } = design;
  const box = frame.getByRole('checkbox', { name: LABEL[key] }).first();
  if (!(await box.isChecked())) {
    await box.click();
    const save = await findSave(page, frame);
    if (!save) throw new Error('Changed the layout but no Save button appeared (looked in the app frame and the admin top bar).');
    await save.click();
    for (let i = 0; i < 40 && (await save.count().catch(() => 0)) > 0 && (await save.isEnabled().catch(() => false)); i++) await page.waitForTimeout(500);
    await page.waitForTimeout(800);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await frame.getByRole('checkbox', { name: 'Vertical' }).first().waitFor({ timeout: 60000 });
  const now = await readLayout(frame);
  if (now !== key) throw new Error(`Saved layout "${key}" but the page reads "${now}".`);
}

module.exports = { openDesign, readLayout, setLayout, LABEL };
