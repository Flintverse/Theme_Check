// The store's theme library: list, install from the Theme Store (free trial), delete. listThemes / installTheme are ported
// from the working theme-canary tool. deleteTheme is NEW and needs a calibration run (README "Not yet verified").
const fs = require('fs');
const path = require('path');
const { showWindow, norm, esc } = require('../lib/browser');

// Every theme in the library: { id, name }. Ids come from the page HTML (reliable); names from the "Edit <name>" links.
async function listThemes(ctx, env) {
  const page = await ctx.newPage();
  await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await showWindow(ctx, page);
  await page.waitForTimeout(7000);
  const found = new Map();
  for (let i = 0; i < 8 && found.size === 0; i++) {
    for (const f of page.frames()) {
      const html = await f.content().catch(() => '');
      for (const m of html.matchAll(/\/themes\/(\d{10,})/g)) if (!found.has(m[1])) found.set(m[1], { id: m[1], name: '' });
      const rows = await f.$$eval('a[href*="/editor"]', (as) => as.map((a) => ({ href: a.href, label: a.getAttribute('aria-label') || '', alt: (a.querySelector('img') && a.querySelector('img').alt) || '' }))).catch(() => []);
      rows.forEach((r) => {
        const m = r.href.match(/\/themes\/(\d+)\/editor/);
        if (!m) return;
        const name = (r.label.replace(/^Edit /, '') || r.alt.replace(/^Theme preview thumbnail for /, '')).trim();
        if (name && !/^Theme preview screenshot$/.test(name)) found.set(m[1], { id: m[1], name });
      });
    }
    if (found.size === 0) await page.waitForTimeout(2000);
  }
  await page.close();
  return Array.from(found.values());
}

async function installTheme(ctx, env, name) {
  const page = await ctx.newPage();
  try {
    const url = `https://themes.shopify.com/login/authenticate?shop=${env.themeStoreShop}&url=${encodeURIComponent('https://themes.shopify.com/themes?q=' + name)}&locale=en`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await showWindow(ctx, page);
    const link = page.getByRole('link', { name: new RegExp(`^Details about the ${esc(name)} theme$`, 'i') }).first();
    try { await link.waitFor({ timeout: 25000 }); } catch (e) { return { ok: false, reason: 'not_in_theme_store' }; }
    await link.click();
    const btn = page.locator('#details-bar').getByRole('button', { name: /Try theme|Add new copy|Add to theme library|Add theme/i }).first();
    await btn.waitFor({ timeout: 30000 });
    await btn.click();
    let landed = false;
    let text = '';
    for (let i = 0; i < 50 && !landed; i++) {
      if (/admin\.shopify\.com\/store\/[^/]+\/themes/.test(page.url())) { landed = true; break; }
      text = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      if (/Theme limit reached|reached the maximum of \d+ themes/i.test(text)) return { ok: false, reason: 'library_full', detail: 'Shopify: maximum number of themes reached.' };
      await page.waitForTimeout(3000);
    }
    if (!landed) return { ok: false, reason: 'install_timeout', detail: text.slice(0, 200) };
    await page.waitForTimeout(4000); // the full 3 minute wait for the theme to be usable is done once per batch by the caller
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'install_error', detail: String(e.message).split(/[\r\n]/)[0].slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}

// Install, then find the new theme id in the library.
async function installAndFind(ctx, env, name, before) {
  const inst = await installTheme(ctx, env, name);
  if (!inst.ok) return inst;
  for (let i = 0; i < 4; i++) {
    const lib = await listThemes(ctx, env);
    const fresh = lib.filter((t) => !before.has(t.id));
    if (fresh.length) return { ok: true, id: fresh[0].id };
  }
  return { ok: false, reason: 'installed_but_not_found' };
}

// NEW, uncalibrated: Themes page > theme card "..." > Delete theme > confirm. Shopify itself refuses to delete the live theme; the caller never passes it.
async function deleteTheme(ctx, env, id, debugDir) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await showWindow(ctx, page);
    await page.waitForTimeout(6000);
    for (const f of page.frames()) {
      const card = f.locator(`a[href*="/themes/${id}"]`).first();
      if (!(await card.count().catch(() => 0))) continue;
      const scope = card.locator('xpath=ancestor::*[.//button][1]');
      const more = scope.getByRole('button', { name: /more actions|actions|\.\.\.|…/i }).first();
      await more.click({ timeout: 8000 });
      await f.getByRole('menuitem', { name: /^delete/i }).first().click({ timeout: 8000 });
      await f.getByRole('button', { name: /^delete$/i }).last().click({ timeout: 8000 });
      await page.waitForTimeout(5000);
      return { ok: true };
    }
    return { ok: false, reason: 'theme_not_on_page' };
  } catch (e) {
    if (debugDir) { fs.mkdirSync(debugDir, { recursive: true }); await page.screenshot({ path: path.join(debugDir, `delete-${id}.png`) }).catch(() => {}); }
    return { ok: false, reason: 'delete_failed', detail: String(e.message).slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}

module.exports = { listThemes, installTheme, installAndFind, deleteTheme, norm };
