// Runs the checklist on one storefront page, one "pass" = one theme x one layout (or the search / mobile passes).
// Every result: { id, layout, status: pass|fail|na|review|error, detail, shots: [relative paths] }
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { measure, measureSuggestion } = require('./measure');

const HIDE_PREVIEW_BAR = '#PBarNextFrame,#preview-bar-iframe,#preview-bar-iframe-wrapper{display:none!important}';
const NOISE = /monorail|trekkie|shop\.app|google|facebook|doubleclick|clarity|hotjar|sentry|favicon|\.map(\?|$)|shopifycloud\/(shop-js|web-pixels)/i;
const FINDTER_URL = /fdt-|findter|rdsearch|\/proxy\/|[?&]shop=/i;

function collectors(page) {
  const st = { console: [], pageErrors: [], bad: [] };
  page.on('console', (m) => { if (m.type() === 'error' && FINDTER_URL.test((m.location() && m.location().url) || '')) st.console.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => { if (/fdt|findter/i.test(String(e.stack || ''))) st.pageErrors.push(String(e.message).slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400 && FINDTER_URL.test(r.url()) && !NOISE.test(r.url())) st.bad.push(`${r.status()} ${r.url().slice(0, 100)}`); });
  return st;
}

class Pass {
  constructor({ page, outDir, relDir, layout, viewport, thresholds, keyword }) {
    Object.assign(this, { page, outDir, relDir, layout, viewport, T: thresholds || {}, keyword: keyword || '3' });
    this.results = [];
    this.n = 0;
  }
  async shot(name, opts) {
    const rel = `${this.relDir}/${String(++this.n).padStart(2, '0')}-${name}.png`;
    const file = path.join(this.outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.page.screenshot(Object.assign({ path: file }, opts || {})).catch(() => {});
    return rel;
  }
  add(id, status, detail, shots) { this.results.push({ id, layout: this.layout, status, detail: detail || '', shots: shots || [], sec: Math.round((Date.now() - (this.t0 || Date.now())) / 100) / 10 }); } // sec = seconds since the pass started, to see where the time goes
  async m(id, shotName, alias, scope) {
    let r;
    try { r = await this.page.evaluate(measure, { id: alias || id, opts: this.T, scope }); } catch (e) { r = { status: 'error', detail: String(e.message).slice(0, 160) }; }
    const shots = r.status === 'na' ? [] : [await this.shot(`${id}-${r.status}`)];
    this.add(id, r.status, r.detail, shots);
    return r;
  }
}

// A development store (or any store with a storefront password) shows a password page instead of the theme.
const GATE = 'form[action*="/password"] input[type=password], input[name="password"][type=password]';
async function onGate(page) { return page.evaluate((sel) => !!document.querySelector(sel), GATE).catch(() => false); }

async function passGate(page, url, password) {
  if (!(await onGate(page))) return { blocked: false };
  if (!password) return { blocked: true, reason: 'The storefront shows the store password page and no storefront password is configured (config.local.json: envs.<env>.storefrontPassword, or the STOREFRONT_PASSWORD_<ENV> variable).' };
  await page.fill(GATE, password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}), page.locator('form[action*="/password"] button, form[action*="/password"] input[type=submit]').first().click()]);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await onGate(page)) return { blocked: true, reason: 'The storefront password was entered but the password page is still showing (wrong password?).' };
  return { blocked: false };
}

async function load(page, url, password) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const gate = await passGate(page, url, password);
  if (gate.blocked) return { ms: Date.now() - t0, blocked: gate.reason };
  await page.waitForSelector('#fdt-container', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.search-filters__product-item', { state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.addStyleTag({ content: HIDE_PREVIEW_BAR }).catch(() => {});
  return { ms: Date.now() - t0, blocked: null };
}

async function openDrawer(page) {
  const found = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const t = Array.from(document.querySelectorAll('#fdt-container .search-filters__open-wrapper, #fdt-container summary, #fdt-container button')).find((e) => vis(e) && /filter/i.test(e.innerText || '') && (e.innerText || '').trim().length < 30);
    if (!t) return false;
    t.setAttribute('data-tc-drawer', '1');
    return true;
  });
  if (!found) return false;
  await page.click('[data-tc-drawer="1"]', { force: true, timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

async function closeDrawer(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  const x = await page.$('.search-filters__close');
  if (x && (await x.isVisible().catch(() => false))) { await x.click({ force: true, timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); }
}

// Pixel diff of a clipped area: how much of it changed between two screenshots (0..1).
function changedRatio(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return 1;
  let diff = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 60) diff++;
  }
  return diff / (A.width * A.height);
}

// ---- The four kinds of filter group the checks are aimed at. Each is found by what it is (the page marks them), not by a name:
//   price = the slider, box = the boxes (Size), checklist = the check boxes (Product category), merged = the nested group (Tag 1).
// A group may be collapsed (the horizontal layout shows it as a dropdown): it is opened for the check and closed again.
const KIND_LABEL = { price: 'Price slider', box: 'Box filter', checklist: 'Checklist filter', merged: 'Merged group' };

async function openGroup(p, kind) {
  const { page } = p;
  const found = await page.evaluate((k) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const has = {
      price: (g) => g.querySelector('fdt-slider'),
      box: (g) => g.querySelector('.search-filters__filter-option-listitem--box:not(.search-filters__filter-option-listitem--box-sort)'),
      checklist: (g) => g.querySelector('.search-filters__filter-option-listitem--checklist'),
      merged: (g) => g.querySelector('.search-filters__filter-option-listitem--nested'),
    }[k];
    const g = Array.from(document.querySelectorAll('#fdt-container filter-option')).find((x) => vis(x) && has(x));
    if (!g) return null;
    const t = g.querySelector('.search-filters__filter-option-title');
    g.setAttribute('data-tc-group', k);
    if (t) t.setAttribute('data-tc-group-title', k);
    return { title: t ? (t.innerText || '').trim() : k };
  }, kind);
  if (!found) return { ok: false, kind };
  const scope = '[data-tc-group="' + kind + '"]';
  const hasValues = () => page.evaluate((sc) => { const g = document.querySelector(sc); return !!g && Array.from(g.querySelectorAll('.fdt-option-item-count, fdt-slider, .fdt-group-value__toggle')).some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); }, scope);
  let opened = false;
  if (!(await hasValues())) { await page.locator('[data-tc-group-title="' + kind + '"]').click({ force: true, timeout: 4000 }).catch(() => {}); opened = true; await page.waitForTimeout(1200); }
  await page.locator(scope).evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
  await page.waitForTimeout(400);
  return { ok: true, kind, scope, title: found.title, opened };
}

async function closeGroup(p, g) {
  if (!g || !g.ok) return;
  if (g.opened) { await p.page.locator('[data-tc-group-title="' + g.kind + '"]').click({ force: true, timeout: 3000 }).catch(() => {}); await p.page.waitForTimeout(500); }
  await p.page.evaluate((k) => document.querySelectorAll('[data-tc-group="' + k + '"],[data-tc-group-title="' + k + '"]').forEach((e) => { e.removeAttribute('data-tc-group'); e.removeAttribute('data-tc-group-title'); }), g.kind).catch(() => {});
}

// One measurement, looked at on each of the given kinds of group; ONE result for the check, saying which group failed.
async function scoped(p, id, shotName, kinds) {
  const parts = [];
  const shots = [];
  for (const kind of kinds) {
    const g = await openGroup(p, kind);
    if (!g.ok) { parts.push({ kind, status: 'missing' }); continue; }
    let r;
    try { r = await p.page.evaluate(measure, { id, opts: p.T, scope: g.scope }); } catch (e) { r = { status: 'error', detail: String(e.message).slice(0, 160) }; }
    if (r.status !== 'na') shots.push(await p.shot(shotName + '-' + kind));
    parts.push({ kind, title: g.title, status: r.status, detail: r.detail });
    await closeGroup(p, g);
  }
  const real = parts.filter((x) => x.status !== 'missing' && x.status !== 'na');
  const bad = real.filter((x) => x.status === 'fail' || x.status === 'error');
  let status, detail;
  if (!real.length) { status = 'na'; detail = 'This collection has no ' + kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(' / ') + ' to look at.'; }
  else if (bad.length) { status = 'fail'; detail = bad.map((x) => x.title + ': ' + x.detail).join('; '); }
  else { status = 'pass'; detail = 'Looked at: ' + real.map((x) => x.title).join(', ') + '.'; }
  p.add(id, status, detail, shots);
  return { status, detail };
}

// A value is clicked in each kind of group: does it look selected? One V-10 result; V-11 (the chip) is read once, while a value is selected.
async function checkSelectedState(p) {
  const { page } = p;
  const parts = [];
  const shots = [];
  let chipDone = false;
  for (const kind of ['checklist', 'box', 'merged']) {
    const g = await openGroup(p, kind);
    if (!g.ok) continue;
    const sel = g.scope + ' .fdt-option-item-count:visible';
    const item = page.locator(sel).first().locator('xpath=ancestor::li[1]');
    if (!(await item.count())) { await closeGroup(p, g); continue; }
    await item.scrollIntoViewIfNeeded().catch(() => {});
    const text = ((await item.innerText().catch(() => '')) || '').trim().split('\n')[0];
    const box = await item.boundingBox();
    if (!box) { await closeGroup(p, g); continue; }
    const before = await page.screenshot({ clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 400), height: box.height } }).catch(() => null);
    const s1 = await p.shot('V-10-' + kind + '-before-click');
    await item.locator('label, .search-filters__filter-option-item-label').first().click({ force: true, timeout: 4000 }).catch(() => item.click({ force: true }));
    await page.waitForTimeout(2200);
    // the group is drawn again after a click (so its marker is gone): look the value up by its text among the visible values
    const again = page.locator('#fdt-container li:visible').filter({ hasText: text }).filter({ has: page.locator('input[type=checkbox]') }).first();
    const box2 = (await again.boundingBox().catch(() => null)) || box;
    const after = await page.screenshot({ clip: { x: Math.max(0, box2.x), y: Math.max(0, box2.y), width: Math.min(box2.width, 400), height: box2.height } }).catch(() => null);
    const s2 = await p.shot('V-10-' + kind + '-after-click');
    const checked = await again.locator('input[type=checkbox]').first().isChecked().catch(() => null);
    if (!before || !after) parts.push({ title: g.title, status: 'error', detail: 'could not take the comparison pictures' }), shots.push(s1, s2);
    else {
      const ratio = changedRatio(before, after);
      if (checked === false) { parts.push({ title: g.title, status: 'fail', detail: '"' + text + '": the click did not select the value.' }); shots.push(s1, s2); }
      else if (ratio < 0.015) { parts.push({ title: g.title, status: 'fail', detail: '"' + text + '" was selected but looks the same as before (only ' + (ratio * 100).toFixed(1) + '% of its pixels changed): no dark fill or tick.' }); shots.push(s1, s2); }
      else { parts.push({ title: g.title, status: 'pass', detail: '"' + text + '" changes visibly when selected (' + (ratio * 100).toFixed(0) + '% of pixels changed)' }); shots.push(s2); }
    }
    if (!chipDone) { chipDone = true; await p.m('V-11', 'chip'); }
    // back to a clean page (a second click does not always remove a filter; the address keeps it), so the next group sees the full list
    await closeGroup(p, g);
    await load(page, p.baseUrl || page.url(), p.password).catch(() => {});
    continue;
  }
  if (!parts.length) { p.add('V-10', 'na', 'No filter value to click on this collection.'); p.add('V-11', 'na', 'No value selected.'); return; }
  const bad = parts.filter((x) => x.status === 'fail' || x.status === 'error');
  p.add('V-10', bad.length ? 'fail' : 'pass', bad.length ? bad.map((x) => x.title + ': ' + x.detail).join('; ') : parts.map((x) => x.title + ': ' + x.detail).join('; '), shots);
}

// Hover on a value of the checklist (or, if there is none, of another group): is the count still readable?
async function checkHover(p) {
  const { page } = p;
  let g = null;
  for (const kind of ['checklist', 'box', 'merged']) { g = await openGroup(p, kind); if (g.ok) break; }
  if (!g || !g.ok) { p.add('V-03', 'na', 'No value with a count to hover.'); return; }
  const item = page.locator(g.scope + ' .fdt-option-item-count:visible').first().locator('xpath=ancestor::li[1]');
  if (!(await item.count())) { p.add('V-03', 'na', 'No value with a count to hover.'); await closeGroup(p, g); return; }
  await item.scrollIntoViewIfNeeded().catch(() => {});
  await item.hover({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await item.evaluate((e) => e.setAttribute('data-tc-hover', '1')).catch(() => {});
  await p.m('V-03', 'hover', undefined, g.scope);
  await item.evaluate((e) => e.removeAttribute('data-tc-hover')).catch(() => {});
  await page.mouse.move(5, 5);
  await closeGroup(p, g);
}

// The merged group (Tag 1): the arrow, the one-line row, and the arrow really expands / collapses.
async function checkMerge(p) {
  const { page } = p;
  const g = await openGroup(p, 'merged');
  if (!g.ok) { p.add('V-05', 'na', 'This collection has no merged group (a group with an expand arrow on its values).'); return; }
  const r = await p.m('V-05', 'merge', undefined, g.scope);
  if (r.status === 'pass') {
    const tg = page.locator(g.scope + ' .fdt-group-value__toggle:visible').first();
    const before = await tg.getAttribute('aria-expanded').catch(() => null);
    await tg.click({ force: true, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
    const after = await tg.getAttribute('aria-expanded').catch(() => null);
    if (before !== null && before === after) {
      const last = p.results[p.results.length - 1];
      last.status = 'fail';
      last.detail = 'Clicking the arrow did not expand or collapse the group.';
    }
    await tg.click({ force: true, timeout: 2000 }).catch(() => {});
  }
  await closeGroup(p, g);
}

// Price slider. Finds the "Price" filter in whatever layout is on screen, opens it when it is collapsed (the horizontal layout
// shows it as a dropdown, the off-canvas layout as a list inside the drawer), then looks at the pixels of the picture:
// is the middle of each dot on the middle of the line?
function dotsOnLine(buf) {
  const img = PNG.sync.read(buf);
  const W = img.width, H = img.height;
  const dark = (x, y) => { const i = (y * W + x) * 4; return img.data[i + 3] > 200 && (img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11) < 110; };
  const dots = [];
  let cur = null;
  for (let x = 0; x < W; x++) {
    let top = -1, bot = -1;
    for (let y = 0; y < H; y++) if (dark(x, y)) { if (top < 0) top = y; bot = y; }
    const big = top >= 0 && bot - top + 1 >= 9; // the line is about 5 px thick, a dot about 16
    if (big) { if (!cur) cur = { x0: x, x1: x, top, bot }; else { cur.x1 = x; cur.top = Math.min(cur.top, top); cur.bot = Math.max(cur.bot, bot); } }
    else if (cur && x - cur.x1 > 2) { dots.push(cur); cur = null; }
  }
  if (cur) dots.push(cur);
  return { scale: img.width, dots: dots.filter((d) => d.x1 - d.x0 >= 6).map((d) => ({ x: (d.x0 + d.x1) / 2, centre: (d.top + d.bot) / 2, size: d.bot - d.top + 1 })) };
}

async function checkPriceSlider(p) {
  const { page } = p;
  const found = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const titles = Array.from(document.querySelectorAll('#fdt-container *')).filter((e) => e.children.length <= 2 && /^price$/i.test((e.innerText || '').trim()) && vis(e));
    for (const t of titles) {
      let n = t;
      for (let i = 0; i < 7 && n; i++) {
        const sl = n.querySelector && n.querySelector('fdt-slider');
        if (sl) { sl.setAttribute('data-tc-price', '1'); t.setAttribute('data-tc-price-title', '1'); return true; }
        n = n.parentElement;
      }
    }
    return false;
  });
  if (!found) { p.add('V-04', 'na', "No 'Price' filter with a slider on this collection."); return; }
  const slider = page.locator('[data-tc-price="1"]');
  const title = page.locator('[data-tc-price-title="1"]');
  let opened = false;
  if (!(await slider.isVisible().catch(() => false))) { await title.click({ force: true, timeout: 4000 }).catch(() => {}); opened = true; await page.waitForTimeout(1500); }
  const cleanup = async () => {
    if (opened) { await title.click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); }
    await page.evaluate(() => document.querySelectorAll('[data-tc-price],[data-tc-price-title]').forEach((e) => { e.removeAttribute('data-tc-price'); e.removeAttribute('data-tc-price-title'); })).catch(() => {});
  };
  if (!(await slider.isVisible().catch(() => false))) { p.add('V-04', 'review', "The 'Price' filter was found but its slider did not open. Look at the picture.", [await p.shot('V-04-slider')]); await cleanup(); return; }
  await slider.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
  await page.waitForTimeout(700);
  const track = await page.locator('[data-tc-price="1"] .fdt-range-slider').first().boundingBox().catch(() => null);
  const shot = await p.shot('V-04-price-slider');
  if (!track) { p.add('V-04', 'review', 'The Price slider is open but its line was not found. Look at the picture.', [shot]); await cleanup(); return; }
  const clip = { x: Math.max(0, track.x - 14), y: Math.max(0, track.y + track.height / 2 - 16), width: track.width + 28, height: 32 };
  const buf = await page.screenshot({ clip }).catch(() => null);
  if (!buf) { p.add('V-04', 'review', 'Could not take a close-up of the slider. Look at the picture.', [shot]); await cleanup(); return; }
  const lineY = track.y + track.height / 2 - clip.y;
  const res = dotsOnLine(buf);
  const k = res.scale / clip.width;
  const diffs = res.dots.map((d) => Math.round(Math.abs(d.centre / k - lineY) * 10) / 10);
  if (res.dots.length < 2) p.add('V-04', 'review', "Found the Price slider but could not see both dots in the picture. Look at the picture.", [shot]);
  else if (Math.max.apply(null, diffs) > 2.5) p.add('V-04', 'fail', 'A dot is ' + Math.max.apply(null, diffs) + 'px away from the middle of the line (limit 2.5px).', [shot]);
  else p.add('V-04', 'pass', 'Price slider: both dots are on the middle of the line (off by ' + diffs.join(' and ') + ' px).', [shot]);
  await cleanup();
}

// Scroll-to-top: like a person. A fresh copy of the page (the earlier checks click filters and change it), then scroll fast with
// the mouse wheel towards the bottom and look at the arrow while scrolling and when the bottom is reached.
async function checkScrollTop(p) {
  const { page } = p;
  await load(page, p.baseUrl || page.url(), p.password).catch(() => {}); // the start address again: no filter left from the earlier checks
  await page.mouse.move(600, 400);
  const shown = () => page.evaluate(() => { const e = Array.from(document.querySelectorAll('fdt-scroll-to-top')).find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return !!e; });
  let seen = false;
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(60);
    if (i % 2 === 1 && (await shown())) { seen = true; break; }
    if (await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4)) break;
  }
  await page.waitForTimeout(seen ? 400 : 1500);
  let r = await page.evaluate(measure, { id: 'V-06', opts: p.T }).catch((e) => ({ status: 'error', detail: String(e.message).slice(0, 160) }));
  if (r.status === 'fail') { // not there yet: a little more movement at the bottom, then look again
    await page.mouse.wheel(0, -300); await page.waitForTimeout(200); await page.mouse.wheel(0, 600);
    await page.waitForTimeout(2000);
    r = await page.evaluate(measure, { id: 'V-06', opts: p.T }).catch((e) => ({ status: 'error', detail: String(e.message).slice(0, 160) }));
  }
  p.add('V-06', r.status, r.detail, [await p.shot('V-06-scroll-bottom')]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function checkChooseOptions(p, id) {
  const { page } = p;
  const btn = page.locator('.search-filters__product-item').getByText(/choose options/i).first();
  if (!(await btn.count())) { p.add(id, 'na', "No product card with 'Choose options' on this collection."); return; }
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const card = btn.locator('xpath=ancestor::*[contains(@class,"search-filters__product-item")][1]');
  await btn.click({ force: true, timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await card.evaluate((e) => e.setAttribute('data-tc-card', '1')).catch(() => {});
  const r = await p.page.evaluate(measure, { id: 'V-09', opts: p.T }).catch((e) => ({ status: 'error', detail: String(e.message) }));
  p.add(id, r.status, r.detail, [await p.shot(`${id}-choose-options`)]);
  await card.evaluate((e) => e.removeAttribute('data-tc-card')).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}

// Which layout is really on screen. A label that was never applied would make every later result meaningless.
async function detectLayout(page) {
  return page.evaluate(() => {
    // Findter marks the layout on its own element: .search-filters__layout.fdt-layout-<horizontal|vertical|offcanvas>
    const marked = document.querySelector('.search-filters__layout');
    const m = marked && String(marked.className).match(/fdt-layout-(horizontal|vertical|offcanvas)/);
    if (m) return m[1];
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    if (Array.from(document.querySelectorAll('.search-filters__open-wrapper')).some(vis)) return 'offcanvas';
    const groups = Array.from(document.querySelectorAll('filter-option, fdt-filter-option')).filter(vis);
    if (groups.length > 1) {
      const tops = groups.map((g) => g.getBoundingClientRect().top);
      return Math.max.apply(null, tops) - Math.min.apply(null, tops) < 40 ? 'horizontal' : 'vertical';
    }
    return groups.length === 1 ? 'vertical' : 'unknown';
  });
}

async function pageChecks(p, c) {
  const expected = p.viewport === 'mobile' ? 'offcanvas' : p.layout === 'search' ? null : p.layout;
  if (expected) {
    const actual = await detectLayout(p.page);
    p.add('G-04', actual === expected ? 'pass' : 'fail', actual === expected ? '' : `expected the ${expected} layout but the page shows: ${actual}. Check Tab 1 (Filter layout saved?) and reload.`);
  }
  await p.m('G-01', 'page');
  await p.m('G-02', 'page');
  const bad = c.console.length + c.pageErrors.length + c.bad.length;
  p.add('G-03', bad ? 'fail' : 'pass', bad ? [...c.pageErrors, ...c.console, ...c.bad].slice(0, 4).join(' | ') : '');
}

// Desktop layouts: vertical / horizontal / offcanvas
async function desktopPass(p, c) {
  const { page } = p;
  await pageChecks(p, c);
  let drawerOpen = false;
  if (p.layout === 'offcanvas') {
    await p.m('O-01', 'filter-by-button');
    drawerOpen = await openDrawer(page);
    await p.m('O-02', 'drawer');
    await p.m('O-03', 'drawer-x');
    await p.m('O-04', 'drawer-price');
  }
  await p.m('V-01', 'search-boxes');
  await scoped(p, 'V-02', 'count-line', ['box', 'checklist', 'merged']);
  await checkHover(p);
  await checkPriceSlider(p);
  await checkMerge(p);
  await scoped(p, 'V-07', 'checkbox', ['checklist', 'merged']);
  await checkSelectedState(p);
  await p.m('V-12', 'icons');
  if (drawerOpen) await closeDrawer(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await p.m('V-08', 'toolbar');
  await checkScrollTop(p);
  await checkChooseOptions(p, 'V-09');
}

async function mobilePass(p, c) {
  const { page } = p;
  await pageChecks(p, c);
  await p.m('M-01', 'filter-and-sort-button');
  const opened = await openDrawer(page);
  const o = await p.page.evaluate(measure, { id: 'O-02', opts: p.T });
  const x = opened ? await p.page.evaluate(measure, { id: 'O-03', opts: p.T }) : { status: 'fail', detail: 'Filter and sort button not found.' };
  const sortR = await p.page.evaluate(measure, { id: 'M-02b', opts: p.T });
  const bad = [o, x, sortR].filter((r) => r.status === 'fail');
  p.add('M-02', bad.length ? 'fail' : o.status === 'pass' ? 'pass' : 'na', bad.map((r) => r.detail).join('; '), [await p.shot('M-02-drawer')]);
  await p.m('M-03', 'drawer-price', 'M-03');
  if (opened) await closeDrawer(page);
  await checkChooseOptions(p, 'M-04');
}

async function openThemeSearch(page) {
  const found = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const base = Array.from(document.querySelectorAll('button, summary, a, [role=button], [data-search-toggle], [data-action*="search" i]')).filter((e) => vis(e) && !e.closest('#fdt-container') && !e.closest('fdt-search-suggestion-widget') && !e.matches('[type=submit], .search__button, [class*=close]'));
    const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.innerText || '')).trim();
    const tiers = [
      (e) => /search/i.test(e.getAttribute('aria-label') || ''),
      (e) => /search/i.test(String(e.className)) && !/form|input|field/i.test(String(e.className)),
      (e) => e.tagName === 'A' && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?search\/?$/.test(new URL(e.href, location.href).pathname),
      (e) => /search/i.test(label(e)) && label(e).length < 40,
    ];
    let pick = null;
    for (const t of tiers) { pick = base.find(t); if (pick) break; }
    if (!pick) return false;
    pick.setAttribute('data-tc-trigger', '1');
    return true;
  });
  if (!found) return false;
  await page.click('[data-tc-trigger="1"]', { timeout: 4000, force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

async function searchPass(p, c) {
  const { page } = p;
  const mobile = p.viewport === 'mobile';
  const P = mobile ? { shell: 'S-M1', one: 'S-M2', back: 'S-M3', usable: 'S-M4' } : { shell: 'S-01', usable: 'S-02', one: 'S-03', size: 'S-04', stable: 'S-05' };
  const trig = await openThemeSearch(page);
  const sShot = await p.shot('search-open');
  if (!trig) {
    [P.shell, P.usable, P.one, P.size, P.back, P.stable].filter(Boolean).forEach((id) => p.add(id, 'fail', "Could not find the theme's search icon, so search could not be opened."));
    return;
  }
  const input = page.locator('input[type=search]:visible, input[name=q]:visible').first();
  const typed = (await input.count()) > 0;
  if (typed) { await input.click({ timeout: 3000 }).catch(() => {}); await page.keyboard.type(p.keyword, { delay: 150 }); await page.waitForTimeout(2200); }
  const m = await page.evaluate(measureSuggestion, { opts: p.T });
  const typedShot = await p.shot('search-typed');
  p.add(P.usable, typed ? 'pass' : 'fail', typed ? '' : 'Search bar is not visible or cannot take text.', [sShot]);
  p.add(P.shell, m.widget && m.watermark ? 'pass' : 'fail', m.widget ? (m.watermark ? '' : "Findter's widget shows but the 'Powered by Findter' watermark is missing.") : (m.hiddenCopy ? "Findter's search widget is on the page, but it is attached to a hidden copy of the theme's search form, so the shopper does not see it (the theme's own suggestion box shows instead)." : m.embedLoaded ? "Findter's search suggestion embed is on but its widget did not appear." : "Findter's Search suggestion embed is not active on this theme (its files are not on the page). Turn it on under App embeds, then retest."), [typedShot]);
  const both = m.widget && m.themeBoxes > 0;
  const theirsOnly = !m.widget && m.themeBoxes > 0;
  p.add(P.one, both ? 'fail' : theirsOnly ? 'fail' : m.widget ? 'pass' : 'na', both ? "Findter's widget and the theme's own suggestion box are shown together." : theirsOnly ? (m.hiddenCopy ? "Only the theme's own suggestion box is shown. Findter's widget is on the page but attached to a hidden copy of the search form." : "Only the theme's own search layout is shown (Findter's is not).") : m.widget ? '' : 'Nothing to compare: Findter widget is not showing.', [typedShot]);
  if (!mobile) {
    if (!m.widget) p.add(P.size, 'na', 'Widget is not showing.');
    else {
      const probs = [];
      if (m.widthDiffPct > p.T.widthDiffPct) probs.push(`widget is ${m.widgetWidth}px wide, search bar ${m.inputWidth}px (${m.widthDiffPct}% different)`);
      if (m.gap !== null && m.gap > p.T.searchGapPx) probs.push(`widget starts ${m.gap}px below the search bar`);
      if (m.gap !== null && m.gap < -4) probs.push(`widget overlaps the search bar by ${-m.gap}px`);
      if (m.covered) probs.push('widget is covered by another element (for example the header)');
      if (m.shiftPx > 12) probs.push(`widget is shifted ${m.shiftPx}px sideways from the bar`);
      p.add(P.size, probs.length ? 'fail' : 'pass', probs.join('; '), [typedShot]);
    }
    p.add(P.stable, 'review', 'Look at the picture: widget stays put and does not expand over the page.', [typedShot]);
  } else {
    p.add(P.back, m.backArrow ? 'pass' : 'fail', m.backArrow ? '' : "No back arrow ('←') next to Findter's search bar.", [typedShot]);
    if (m.backArrow) {
      const back = page.locator('.search-filters__search-suggestion-close-button:visible').first();
      await back.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const m2 = await page.evaluate(measureSuggestion, { opts: p.T });
      const s3 = await p.shot('after-back');
      if (m2.searchInputs > 1) { const last = p.results.find((r) => r.id === P.back); last.status = 'fail'; last.detail = 'After tapping the back arrow a second search bar (the theme\'s) appeared.'; last.shots.push(s3); }
    }
  }
  void c;
}

// One pass = one fresh context, one set of results. Evidence is a screenshot taken at the moment of each check (no video).
async function runPass({ browser, url, layout, viewportName, viewport, outDir, relDir, thresholds, keyword, password, cookies }) {
  const mobile = viewportName === 'mobile';
  const ctx = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' : undefined,
    // the preview session of the editor (see editor.getPreviewUrl): lets a draft theme or a password store open
    storageState: cookies && cookies.length ? { cookies, origins: [] } : undefined,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000); // a missing element costs 8 s, not the 30 s default (navigation waits set their own, longer limits)
  const c = collectors(page);
  const p = new Pass({ page, outDir, relDir, layout, viewport: viewportName, thresholds, keyword });
  p.t0 = Date.now();
  p.baseUrl = url; p.password = password; // the clean start address (no filters in it), for the checks that need a fresh page
  let blocked = null;
  try {
    const loaded = await load(page, url, password);
    p.firstCardMs = loaded.ms;
    if (loaded.blocked) { p.add('G-05', 'fail', loaded.blocked, [await p.shot('storefront-blocked')]); blocked = loaded.blocked; }
    else if (layout === 'search') await searchPass(p, c);
    else if (mobile) await mobilePass(p, c);
    else await desktopPass(p, c);
  } catch (e) {
    p.add('G-01', 'error', `Pass crashed: ${String(e.message).slice(0, 200)}`);
  } finally {
    await ctx.close();
  }
  return { layout, viewport: viewportName, results: p.results, blocked };
}

// Before the tests: is Findter on the storefront of this theme? Looks at the collection page again and again (a fresh load each
// time, every 20 s) until its container shows, or the time is up. A password page is reported as such.
// Is Findter really on the storefront? Looks at the given collection page; some themes do not draw Findter on the
// "all products" page (/collections/all) but do on a real collection. So when the first page has none, the real collections
// linked on that page (the store menu) are tried too, and the page that works is returned as url: the checks then use it.
async function waitFindter({ browser, url, cookies, password, maxMs, selectorMs, pollMs }) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, storageState: cookies && cookies.length ? { cookies, origins: [] } : undefined });
  const page = await ctx.newPage();
  const until = Date.now() + (maxMs || 240000);
  let last = 'the page did not load', n = 0, others = null;
  const tryUrl = async (u) => {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const gate = await passGate(page, u, password);
    if (gate.blocked) return { blocked: gate.reason };
    return { has: await page.waitForSelector('#fdt-container', { timeout: selectorMs || 20000 }).then(() => true, () => false) };
  };
  try {
    while (Date.now() < until) {
      n++;
      try {
        const r = await tryUrl(url);
        if (r.blocked) return { ok: false, blocked: true, detail: r.blocked };
        if (r.has) return { ok: true, detail: '', looks: n, url };
        if (!others) others = await page.evaluate(() => {
          const seen = new Set();
          return Array.from(document.querySelectorAll('a[href*="/collections/"]')).map((a) => { try { return new URL(a.href, location.href).pathname; } catch (e) { return ''; } })
            .filter((p) => /^\/collections\/[^/]+\/?$/.test(p) && !/^\/collections\/(all|vendors|types)\/?$/.test(p) && !seen.has(p) && seen.add(p)).slice(0, 4);
        }).catch(() => []);
        for (const p of others) {
          const u = new URL(p, url).toString();
          const o = await tryUrl(u);
          if (o.has) return { ok: true, detail: '', looks: n, url: u, note: 'Findter is not drawn on ' + new URL(url).pathname + ' in this theme; the checks ran on ' + p + ' instead.' };
        }
        last = "Findter's container (#fdt-container) is not on the collection page" + (others.length ? ' (nor on ' + others.join(', ') + ')' : '') + ' after ' + n + ' look(s) over ' + Math.round((maxMs || 240000) / 60000) + ' minutes';
      } catch (e) { last = "Findter's container (#fdt-container) is not on the collection page after " + n + ' look(s) over ' + Math.round((maxMs || 240000) / 60000) + ' minutes'; }
      await page.waitForTimeout(pollMs || 20000);
    }
    return { ok: false, detail: last };
  } finally { await ctx.close().catch(() => {}); }
}

module.exports = { runPass, load, collectors, changedRatio, detectLayout, dotsOnLine, waitFindter };
