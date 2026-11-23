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
  await settlePage(page, frame);
  return { page, frame, shotDir: null };
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

// The app loads its plan status a few seconds AFTER the layout checkboxes are there (for example the "Store limit reached" banner,
// which pushes the page down and redraws the form). A click made before that can be wiped. So wait until the page has stopped moving.
async function settlePage(page, frame, maxMs = 14000) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const box = frame.getByRole('checkbox', { name: 'Horizontal' }).first();
  let last = null, still = 0;
  const until = Date.now() + maxMs;
  while (Date.now() < until && still < 3) {
    const bb = await box.boundingBox({ timeout: 2000 }).catch(() => null);
    const pos = bb ? Math.round(bb.y) : null;
    still = pos !== null && pos === last ? still + 1 : 0;
    last = pos;
    await page.waitForTimeout(700);
  }
}

// A notice shown on the design page about the plan ("Store limit reached", trial ended...), or '' when there is none.
async function readNotice(frame) {
  try {
    const t = await frame.locator('body').innerText({ timeout: 4000 });
    const m = t.match(/Store limit reached[^\n]*\n[^\n]*/i) || t.match(/free trial (has )?ended[^\n]*/i);
    return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  } catch (e) { return ''; }
}

async function reloadDesign(design) {
  await design.page.reload({ waitUntil: 'domcontentloaded' });
  await design.frame.getByRole('checkbox', { name: 'Vertical' }).first().waitFor({ timeout: 60000 });
  await settlePage(design.page, design.frame);
}

// Choose a layout, Save, then prove it persisted by reloading the page and reading it back.
// No Save button after the click: the click may have been wiped by the page redrawing, so reload and try again (3 tries). Each failed try
// leaves a picture of the page in design.shotDir (when set), so the cause can be seen.
async function setLayout(design, key, tries = 3) {
  const { page, frame } = design;
  let lastErr = null;
  for (let n = 1; n <= tries; n++) {
    const box = frame.getByRole('checkbox', { name: LABEL[key] }).first();
    if (!(await box.isChecked())) {
      if (n === 1) await settlePage(page, frame); // the page may still be redrawing (plan notice): a click now can be wiped
      await box.click();
      const save = await findSave(page, frame);
      if (!save) {
        const notice = await readNotice(frame);
        if (design.shotDir) { try { require('fs').mkdirSync(design.shotDir, { recursive: true }); await page.screenshot({ path: require('path').join(design.shotDir, `layout-${key}-no-save-try${n}.png`) }); } catch (e) { /* the picture is only help */ } }
        lastErr = new Error(`Changed the layout to ${key} but no Save button appeared (looked in the app frame and the admin top bar)${n < tries ? ' - reloading and trying again' : ''}${notice ? '. The page says: ' + notice : ''}.`);
        if (n < tries) { await reloadDesign(design); continue; }
        throw lastErr;
      }
      await save.click();
      for (let i = 0; i < 40 && (await save.count().catch(() => 0)) > 0 && (await save.isEnabled().catch(() => false)); i++) await page.waitForTimeout(500);
      await page.waitForTimeout(800);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await frame.getByRole('checkbox', { name: 'Vertical' }).first().waitFor({ timeout: 60000 });
    const now = await readLayout(frame);
    if (now === key) return;
    lastErr = new Error(`Saved layout "${key}" but the page reads "${now}".`);
    if (n < tries) await settlePage(page, frame);
  }
  throw lastErr;
}

module.exports = { openDesign, readLayout, setLayout, settlePage, readNotice, LABEL };
