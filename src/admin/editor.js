// Tab 2: the theme editor. Steps follow docs/WORKFLOW.md section A.4.
// Embed switching / Theme list / Save are ported from the working theme-canary tool.
// getPreviewUrl() and exitEditor() are NEW and need a calibration run on the real editor (see README "Not yet verified").
const fs = require('fs');
const path = require('path');
const { showWindow, norm } = require('../lib/browser');
const { measure } = require('../checks/measure');

async function editorFrame(page) {
  for (let i = 0; i < 70; i++) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const a = await f.getByRole('button', { name: 'Open app embeds panel' }).count().catch(() => 0);
      const b = await f.getByPlaceholder('Search app embeds').count().catch(() => 0);
      if (a || b) return f;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('theme editor did not load');
}

// The editor keeps working for a few seconds after every change (a thin progress line runs at the top).
async function waitIdle(page, f) {
  const sel = '[role="progressbar"]:visible, [class*="LoadingBar" i]:visible, [class*="loading-bar" i]:visible, [class*="Polaris-Loading" i]:visible, [class*="topbar-progress" i]:visible';
  const t0 = Date.now();
  let calm = 0;
  while (Date.now() - t0 < 45000 && calm < 4) {
    const busy = (await page.locator(sel).count().catch(() => 0)) + (f ? await f.locator(sel).count().catch(() => 0) : 0);
    calm = busy === 0 ? calm + 1 : 0;
    await page.waitForTimeout(500);
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

async function openEditor(ctx, env, themeId) {
  const page = await ctx.newPage();
  await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes/${themeId}/editor?context=apps&previewPath=%2Fcollections%2Fall`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await showWindow(ctx, page);
  const f = await editorFrame(page);
  await waitIdle(page, f);
  return { page, f };
}

async function openEmbedsPanel(page, f) {
  const searchBox = f.getByPlaceholder('Search app embeds');
  if ((await searchBox.count()) === 0) {
    await f.getByRole('button', { name: 'Open app embeds panel' }).click();
    await searchBox.waitFor({ timeout: 20000 });
  }
  return searchBox;
}

// WORKFLOW A.4 Tab 2: core embed on, wait 10 s.
async function enableCore(ed) {
  const { page, f } = ed;
  const searchBox = await openEmbedsPanel(page, f);
  await waitIdle(page, f);
  const enable = f.getByRole('button', { name: 'Enable Search & filter core' });
  const disable = f.getByRole('button', { name: 'Disable Search & filter core' });
  const have = async () => (await enable.count()) + (await disable.count()) > 0;
  for (let i = 0; i < 45 && !(await have()); i++) await page.waitForTimeout(1000);
  if (!(await have())) {
    await searchBox.fill('Search & filter');
    for (let i = 0; i < 8 && !(await have()); i++) await page.waitForTimeout(1000);
    if (!(await have())) throw new Error('Findter "Search & filter core" embed not found in this theme');
  }
  if (await enable.count()) { await enable.click(); await page.waitForTimeout(10000); return 'core on'; }
  return 'core already on';
}

// WORKFLOW P-01: the "Compatibility issue detected" panel lives in the storefront preview frame of the editor.
async function checkCompatPanel(ed, outDir, relDir, thresholds) {
  const { page } = ed;
  await page.waitForTimeout(10000);
  for (const fr of page.frames()) {
    const has = await fr.evaluate(() => !!document.getElementById('fdt-popup-theme-detect')).catch(() => false);
    if (!has) continue;
    const r = await fr.evaluate(measure, { id: 'P-01', opts: thresholds }).catch((e) => ({ status: 'error', detail: String(e.message).slice(0, 160) }));
    const rel = `${relDir}/P-01-compat-panel.png`;
    fs.mkdirSync(path.join(outDir, relDir), { recursive: true });
    await page.screenshot({ path: path.join(outDir, rel) }).catch(() => {});
    return { id: 'P-01', layout: 'panel', status: r.status, detail: r.detail, shots: [rel] };
  }
  return { id: 'P-01', layout: 'panel', status: 'na', detail: 'Compatibility panel did not appear in the editor preview (embed not active yet, or theme already chosen).', shots: [] };
}

// WORKFLOW A.4: pick the theme in the core block's Theme list, enable Search suggestion, Save.
async function chooseThemeAndSave(ed, themeName) {
  const { page } = ed;
  let { f } = ed;
  const steps = [];
  const searchBox = await openEmbedsPanel(page, f);
  if ((await searchBox.inputValue().catch(() => '')) !== '') { await searchBox.fill(''); await page.waitForTimeout(1500); }
  await f.getByRole('button', { name: /^Search & filter core/ }).click();
  const sel = f.getByLabel('Theme list');
  await sel.waitFor({ timeout: 25000 });
  const options = await sel.locator('option').allTextContents();
  const match = options.find((o) => norm(o) === norm(themeName));
  if (!match) return { ok: false, reason: 'not_in_findter_theme_list', detail: `Findter's Theme list has no "${themeName}"`, steps };
  await sel.selectOption({ label: match });
  steps.push(`theme list = ${match}`);
  await page.waitForTimeout(12000); // template of the app is applied to the theme
  const enableSug = f.getByRole('button', { name: 'Enable Search suggestion' });
  if (await enableSug.count()) { await enableSug.click(); steps.push('suggestion on'); await page.waitForTimeout(20000); }
  else if (await f.getByRole('button', { name: 'Disable Search suggestion' }).count()) steps.push('suggestion already on');
  else steps.push('suggestion embed not found');
  await waitIdle(page, f);
  const save = f.getByRole('button', { name: 'Save', exact: true });
  if (await save.isEnabled()) {
    await save.click();
    await page.waitForTimeout(4000);
    await waitIdle(page, f);
    await page.waitForTimeout(5000);
    steps.push('saved');
  } else steps.push('nothing to save');
  // prove it persisted: reload and read the core switch back
  await page.reload({ waitUntil: 'domcontentloaded' });
  f = await editorFrame(page);
  ed.f = f;
  await waitIdle(page, f);
  await openEmbedsPanel(page, f);
  const on = f.getByRole('button', { name: 'Disable Search & filter core' });
  for (let i = 0; i < 45 && (await on.count()) === 0; i++) await page.waitForTimeout(1000);
  if ((await on.count()) === 0) return { ok: false, reason: 'save_not_persisted', detail: 'After reloading the editor the core embed is OFF.', steps };
  steps.push('reloaded: core embed is on');
  return { ok: true, steps };
}

// WORKFLOW A.4: "..." on the editor header, then Preview. The tab that opens is Tab 3.
// Returns { url, via }. Falls back to the anonymous preview_theme_id URL if the menu cannot be driven.
async function getPreviewUrl(ed, env, themeId) {
  const { page } = ed;
  const fallback = `https://${env.shop}/collections/all?preview_theme_id=${themeId}`;
  try {
    const more = page.getByRole('button', { name: /more actions|^more$|\.\.\.|…/i }).first();
    await more.click({ timeout: 8000 });
    const item = page.getByRole('menuitem', { name: /^preview$/i }).first();
    const popupP = page.context().waitForEvent('page', { timeout: 15000 });
    await item.click({ timeout: 8000 });
    const popup = await popupP;
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    const url = popup.url();
    await popup.close().catch(() => {});
    if (/^https?:\/\//.test(url) && !/about:blank/.test(url)) return { url: ensureCollection(url, env), via: 'editor Preview' };
  } catch (e) { /* menu not found: use the fallback */ }
  return { url: fallback, via: 'preview_theme_id fallback (editor Preview menu not driven)' };
}

function ensureCollection(url, env) {
  const u = new URL(url);
  if (!/\/collections\//.test(u.pathname)) u.pathname = '/collections/all';
  void env;
  return u.toString();
}

// WORKFLOW A.4 "end of each theme": the Exit icon (top-left of the editor) takes us back to the themes list.
async function exitEditor(ed, env) {
  const { page } = ed;
  try {
    const exit = page.getByRole('button', { name: /^exit$|exit/i }).first();
    await exit.click({ timeout: 6000 });
    await page.waitForURL(/\/themes(\?|$|\/?$)/, { timeout: 15000 });
  } catch (e) {
    await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  await page.close().catch(() => {});
}

module.exports = { openEditor, enableCore, checkCompatPanel, chooseThemeAndSave, getPreviewUrl, exitEditor };
