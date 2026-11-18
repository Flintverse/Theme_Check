// The store's theme library: list, install from the Theme Store (free trial), delete. listThemes / installTheme are ported
// from the working theme-canary tool. deleteTheme is NEW and needs a calibration run (README "Not yet verified").
const fs = require('fs');
const path = require('path');
const { showWindow, norm, esc } = require('../lib/browser');

const BOT = /verify you are human|connection needs to be verified/i;

async function readLibraryOnce(page) {
  const found = new Map();
  for (const f of page.frames()) {
    const html = await f.content().catch(() => '');
    for (const m of html.matchAll(/\/themes\/(\d{10,})/g)) if (!found.has(m[1])) found.set(m[1], { id: m[1], name: '' });
    const rows = await f.$$eval('a[href*="/editor"]', (as) => as.map((a) => ({ href: a.href, label: a.getAttribute('aria-label') || '', alt: (a.querySelector('img') && a.querySelector('img').alt) || '' }))).catch(() => []);
    rows.forEach((r) => {
      const m = r.href.match(/\/themes\/(\d+)\/editor/);
      if (!m) return;
      if (r.label === 'Edit theme') { const cur = found.get(m[1]) || { id: m[1], name: '' }; cur.live = true; found.set(m[1], cur); return; }
      const name = (r.label.replace(/^Edit /, '') || r.alt.replace(/^Theme preview thumbnail for /, '')).trim();
      if (name && !/^Theme preview screenshot$/.test(name)) { const cur = found.get(m[1]) || { id: m[1], name: '' }; cur.name = name; found.set(m[1], cur); }
    });
  }
  return found;
}

// Every theme in the library: { id, name }. Ids come from the page HTML (reliable); names from the "Edit <name>" links.
// The page fills in over several seconds, so read it until two reads in a row agree. A robot check page is an error,
// never an empty library (an empty library would make the caller install themes it already has).
async function listThemes(ctx, env) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await showWindow(ctx, page);
    await page.waitForTimeout(6000);
    let prev = '';
    let last = new Map();
    for (let i = 0; i < 10; i++) {
      const text = await page.locator('body').innerText().catch(() => '');
      if (BOT.test(text)) throw new Error('Shopify showed a robot check ("Verify you are human") instead of the themes page. Run: node src/cli.js login --env <env> (visible window), pass the check, and run again.');
      last = await readLibraryOnce(page);
      const sig = Array.from(last.values()).map((x) => x.id + ':' + x.name).sort().join('|');
      if (last.size > 0 && sig === prev) break;
      prev = sig;
      await page.waitForTimeout(3000);
    }
    return Array.from(last.values());
  } finally { await page.close().catch(() => {}); }
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

// Install, then find the new theme id. Only a theme NAMED like the one asked for counts: never "whatever is new in the list".
async function installAndFind(ctx, env, name, before) {
  const inst = await installTheme(ctx, env, name);
  if (!inst.ok) return inst;
  for (let i = 0; i < 4; i++) {
    const lib = await listThemes(ctx, env);
    const fresh = lib.filter((t) => !before.has(t.id) && t.name && norm(t.name) === norm(name));
    if (fresh.length) return { ok: true, id: fresh[0].id };
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, reason: 'installed_but_not_found', detail: `No new theme named "${name}" appeared in the library.` };
}

// Is a theme still shown on the themes page? Reloads the page, so a stale view cannot fool the check.
async function themeStillListed(ctx, env, id) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    for (const f of page.frames()) if (await f.locator(`a[href*="/themes/${id}/editor"]`).count().catch(() => 0)) return true;
    return false;
  } finally { await page.close().catch(() => {}); }
}

// Themes page > the theme row's "Click for more theme actions" > Delete > confirm in the modal (which lives in its own frame).
// Shopify itself refuses to delete the live theme; the caller never passes it. Returns { ok } or { ok:false, reason, detail }.
// When it fails it saves a picture and the dialog text, so the cause can be read afterwards.
async function deleteOnce(ctx, env, id, debugDir) {
  const page = await ctx.newPage();
  const diag = { dialog: '', notes: [] };
  try {
    await page.goto(`https://admin.shopify.com/store/${env.adminHandle}/themes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await showWindow(ctx, page);
    await page.waitForTimeout(7000);
    for (const f of page.frames()) {
      const link = f.locator(`a[href*="/themes/${id}/editor"]`).first();
      if (!(await link.count().catch(() => 0))) continue;
      const row = link.locator('xpath=ancestor::*[.//button[@aria-label="Click for more theme actions"]][1]');
      await row.locator('button[aria-label="Click for more theme actions"]').first().click({ timeout: 8000 });
      await page.waitForTimeout(800);
      await row.getByText(/^Delete$/).first().click({ timeout: 8000 });
      let confirmBtn = null;
      for (let i = 0; i < 20 && !confirmBtn; i++) {
        for (const fr of page.frames()) {
          const cancel = await fr.getByRole('button', { name: /^Cancel$/ }).count().catch(() => 0);
          const del = fr.getByRole('button', { name: /^Delete$/ });
          if (cancel && (await del.count().catch(() => 0))) { confirmBtn = del.last(); diag.dialog = (await fr.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200); break; }
        }
        if (!confirmBtn) await page.waitForTimeout(500);
      }
      if (!confirmBtn) { diag.notes.push('no confirm dialog'); throw new Error('delete_confirm_not_found'); }
      // The dialog's Delete button is clickable a moment before it is wired up: a click right away does nothing (seen in
      // a real run, the dialog stayed open). Let it settle, click, and click again while the dialog is still open.
      await page.waitForTimeout(2000);
      for (let k = 0; k < 4; k++) {
        await confirmBtn.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(3500);
        const open = await Promise.all(page.frames().map((fr) => fr.getByRole('button', { name: /^Cancel$/ }).count().catch(() => 0)));
        if (!open.some((n) => n > 0)) break;
        diag.notes.push('dialog still open after click ' + (k + 1));
      }
      // the page may keep showing the row for a while: judge by a reload, up to ~60 s
      for (let i = 0; i < 5; i++) {
        if (!(await themeStillListed(ctx, env, id))) return { ok: true };
        await page.waitForTimeout(10000);
      }
      throw new Error('delete_not_confirmed_by_page');
    }
    return { ok: false, reason: 'theme_not_on_page' };
  } catch (e) {
    const msg = String(e.message).split(/[\r\n]/)[0].slice(0, 160);
    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      await page.screenshot({ path: path.join(debugDir, `delete-${id}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(debugDir, `delete-${id}.json`), JSON.stringify({ id, error: msg, diag, at: new Date().toISOString() }, null, 2));
    }
    return { ok: false, reason: /^delete_/.test(msg) ? msg : 'delete_failed', detail: msg + (diag.dialog ? ' | dialog: ' + diag.dialog : '') };
  } finally { await page.close().catch(() => {}); }
}

// Up to 3 attempts with a pause between them.
async function deleteTheme(ctx, env, id, debugDir) {
  let r = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await deleteOnce(ctx, env, id, debugDir);
    if (r.ok || r.reason === 'theme_not_on_page') return r;
    await new Promise((res) => setTimeout(res, 20000 * attempt));
  }
  return r;
}

// The themes page shows the live theme and at most 5 draft themes, newest first, so a store with more themes needs
// several passes: delete what is shown, read again, until only the live theme is left. The live theme is never touched.
async function cleanDrafts(ctx, env, log, debugDir) {
  let deleted = 0;
  const failed = new Set();
  for (let pass = 0; pass < 12; pass++) {
    const lib = await listThemes(ctx, env);
    const drafts = lib.filter((t) => !t.live && !failed.has(t.id));
    if (!drafts.length) break;
    for (const t of drafts) {
      const r = await deleteTheme(ctx, env, t.id, debugDir);
      if (r.ok) { deleted++; log('  deleted ' + (t.name || t.id)); } else { failed.add(t.id); log('  could not delete ' + (t.name || t.id) + ': ' + r.reason); }
    }
  }
  return { deleted, failed: Array.from(failed) };
}

module.exports = { cleanDrafts, listThemes, installTheme, installAndFind, deleteTheme, norm };
