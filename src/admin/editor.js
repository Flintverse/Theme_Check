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
  // The tool changes app embeds and Findter's settings. Never do that on the live theme of a store.
  if (!env.allowLiveTheme && (await f.getByText(/^Active$/).count().catch(() => 0)) > 0) {
    await page.close().catch(() => {});
    throw Object.assign(new Error('This theme is the live (Active) theme of the store. The tool only works on draft themes unless the environment sets allowLiveTheme, so it stopped before changing anything.'), { reason: 'theme_is_live' });
  }
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

// WORKFLOW A.4 Tab 2: core embed on. Switch it, give the editor time to apply it, and prove it is on (the button now offers "Disable").
async function enableCore(ed, delays) {
  const d = Object.assign({ afterEnable: 25000 }, delays || {});
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
  if (await enable.count()) {
    await enable.click();
    await page.waitForTimeout(d.afterEnable);
    await waitIdle(page, f);
    for (let i = 0; i < 40 && (await disable.count()) === 0; i++) await page.waitForTimeout(1000); // is it really on now?
    if ((await disable.count()) === 0) throw new Error('Clicked "Enable Search & filter core" but the editor still offers Enable (the switch did not take).');
    return 'core on';
  }
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

// WORKFLOW A.4: pick the theme in the core block's Theme list, enable Search suggestion, Save. Every switch gets time to apply
// and is checked; after the save the editor is reloaded and all three are read back (core on, Theme list = this theme,
// Search suggestion on). If one did not stick, the whole thing is done once more.
async function readBack(page, themeName) {
  const ed = { page };
  ed.f = await editorFrame(page);
  await waitIdle(page, ed.f);
  await openEmbedsPanel(page, ed.f);
  const f = ed.f;
  const out = { f, core: false, theme: '', suggestion: false };
  const on = f.getByRole('button', { name: 'Disable Search & filter core' });
  for (let i = 0; i < 45 && (await on.count()) === 0; i++) await page.waitForTimeout(1000);
  out.core = (await on.count()) > 0;
  out.suggestion = (await f.getByRole('button', { name: 'Disable Search suggestion' }).count()) > 0;
  if (out.core) {
    await f.getByRole('button', { name: /^Search & filter core/ }).click().catch(() => {});
    const sel = f.getByLabel('Theme list');
    if (await sel.waitFor({ timeout: 25000 }).then(() => true, () => false)) out.theme = await sel.evaluate((e) => (e.options[e.selectedIndex] || {}).text || '').catch(() => '');
  }
  out.themeOk = norm(out.theme) === norm(themeName);
  return out;
}

async function setupOnce(ed, themeName, steps, d) {
  const { page } = ed;
  const f = ed.f;
  const searchBox = await openEmbedsPanel(page, f);
  if ((await searchBox.inputValue().catch(() => '')) !== '') { await searchBox.fill(''); await page.waitForTimeout(1500); }
  await f.getByRole('button', { name: /^Search & filter core/ }).click();
  const sel = f.getByLabel('Theme list');
  await sel.waitFor({ timeout: 25000 });
  const options = await sel.locator('option').allTextContents();
  const match = options.find((o) => norm(o) === norm(themeName));
  if (!match) return { ok: false, reason: 'not_in_findter_theme_list', detail: `Findter's Theme list has no "${themeName}"` };
  await sel.selectOption({ label: match });
  steps.push(`theme list = ${match}`);
  await page.waitForTimeout(d.afterThemeList); // the app applies its template to the theme
  await waitIdle(page, f);
  const enableSug = f.getByRole('button', { name: 'Enable Search suggestion' });
  const disableSug = f.getByRole('button', { name: 'Disable Search suggestion' });
  if (await enableSug.count()) {
    await enableSug.click();
    await page.waitForTimeout(d.afterSuggestion);
    await waitIdle(page, f);
    for (let i = 0; i < 40 && (await disableSug.count()) === 0; i++) await page.waitForTimeout(1000);
    steps.push((await disableSug.count()) ? 'suggestion on' : 'suggestion click did not take');
  } else if (await disableSug.count()) steps.push('suggestion already on');
  else steps.push('suggestion embed not found');
  // everything is switched: wait, then Save and wait until the editor says it is saved (Save is greyed out again)
  await page.waitForTimeout(d.beforeSave);
  await waitIdle(page, f);
  const save = f.getByRole('button', { name: 'Save', exact: true });
  for (let i = 0; i < 60 && !(await save.isEnabled().catch(() => false)); i++) await page.waitForTimeout(1000); // it can take a moment to wake up
  if (await save.isEnabled().catch(() => false)) {
    await save.click();
    for (let i = 0; i < 90 && (await save.isEnabled().catch(() => false)); i++) await page.waitForTimeout(1000);
    await waitIdle(page, f);
    await page.waitForTimeout(d.afterSave);
    steps.push('saved');
  } else steps.push('nothing to save');
  return { ok: true };
}

async function chooseThemeAndSave(ed, themeName, delays) {
  const d = Object.assign({ afterThemeList: 25000, afterSuggestion: 30000, beforeSave: 10000, afterSave: 20000 }, delays || {});
  const steps = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) steps.push('not everything stuck: doing it once more');
    const r = await setupOnce(ed, themeName, steps, d);
    if (!r.ok) return Object.assign(r, { steps });
    // prove it persisted: reload the editor and read all three switches back
    await ed.page.reload({ waitUntil: 'domcontentloaded' });
    const back = await readBack(ed.page, themeName);
    ed.f = back.f;
    // The Theme list is NOT part of the proof: after a reload the editor shows it empty although Findter still works with the theme chosen (seen on Maximize).
    // The proof that the choice took is the storefront check that follows (Findter's container must show).
    steps.push(`read back: core ${back.core ? 'on' : 'OFF'}, suggestion ${back.suggestion ? 'on' : 'OFF'}${back.theme ? ', theme list shows "' + back.theme + '"' : ''}`);
    if (back.core && back.suggestion) { steps.push('reloaded: core and suggestion are on'); return { ok: true, steps }; }
    if (attempt === 2) {
      const what = [!back.core && 'the core embed is OFF', !back.suggestion && 'Search suggestion is OFF'].filter(Boolean).join('; ');
      return { ok: false, reason: 'save_not_persisted', detail: 'After saving and reloading the editor: ' + what + '.', steps };
    }
    ed.f = back.f;
  }
  return { ok: false, reason: 'save_not_persisted', detail: 'unknown', steps };
}

// WORKFLOW A.4: "..." (View actions) on the editor header, then Preview. The tab that opens is Tab 3.
// The menu lives inside the editor frame, not in the admin page. The preview works through the cookies Shopify sets for
// this admin session (the address itself is just /collections/all), so the cookies are returned for the test contexts:
// a draft or trial theme, or a store with a password, cannot be opened by its address alone.
// Falls back to the preview_theme_id address if the menu cannot be driven.
async function getPreviewUrl(ed, env, themeId) {
  const { page, f } = ed;
  const ctx = page.context();
  const fallback = `https://${env.shop}/collections/all?preview_theme_id=${themeId}`;
  try {
    await f.getByRole('button', { name: 'View actions' }).click({ timeout: 10000 });
    await page.waitForTimeout(800);
    const popupP = ctx.waitForEvent('page', { timeout: 20000 });
    popupP.catch(() => {}); // if the click fails first, this must not become an unhandled rejection
    await f.getByText(/^Preview$/).first().click({ timeout: 8000 });
    const popup = await popupP;
    await popup.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await popup.waitForTimeout(4000);
    const url = popup.url();
    const cookies = await ctx.cookies(`https://${env.shop}`);
    await popup.close().catch(() => {});
    if (/^https?:\/\//.test(url) && !/about:blank/.test(url)) return { url: ensureCollection(url), via: 'editor Preview', cookies };
  } catch (err) { /* menu not found: use the fallback */ }
  return { url: fallback, via: 'preview_theme_id fallback (editor Preview menu not driven)', cookies: null };
}

function ensureCollection(url) {
  const u = new URL(url);
  if (!/\/collections\//.test(u.pathname)) u.pathname = '/collections/all';
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

// Is a freshly installed theme really editable? Opens its editor and waits for the editor itself (the app embeds panel),
// then closes the page. Never changes anything.
async function probeEditor(ctx, env, themeId) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes/${themeId}/editor?context=apps&previewPath=%2Fcollections%2Fall`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await showWindow(ctx, page);
    await editorFrame(page); // throws when the editor does not load in about 70 s
    return { ok: true, detail: '' };
  } catch (e) {
    return { ok: false, detail: String(e.message).split(/\r?\n/)[0].slice(0, 160) };
  } finally { await page.close().catch(() => {}); }
}

module.exports = { probeEditor, openEditor, enableCore, checkCompatPanel, chooseThemeAndSave, getPreviewUrl, exitEditor };
