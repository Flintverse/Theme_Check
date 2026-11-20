// The in-page measurements must pass a correct layout and catch the known bugs from the Google Sheet.
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright-core');
const { measure, measureSuggestion } = require('../src/checks/measure');

let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(async () => { await browser.close(); });

async function run(html, id, extra) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<!doctype html><body style="margin:0;font:14px Arial">${html}</body>`);
  if (extra) await extra(page);
  const r = await page.evaluate(measure, { id, opts: {} });
  await page.close();
  return r;
}

const wrap = (inner) => `<div id="fdt-container" style="width:400px">${inner}</div>`;
const item = (countStyle, boxCss) => wrap(`
<style>.lab::before{content:"";display:inline-block;${boxCss || 'width:14px;height:14px'};border:1px solid #000;margin-right:6px;vertical-align:middle}</style>
<filter-option-item style="display:flex;align-items:center;justify-content:space-between;height:30px">
  <label style="display:flex;align-items:center"><input type="checkbox" style="width:14px;height:14px"><span class="search-filters__filter-option-item-label lab">Adidas</span></label>
  <span class="fdt-option-item-count" style="${countStyle}">(176)</span>
</filter-option-item>`);

test('V-02 passes when the count shares the value line', async () => {
  const r = await run(item(''), 'V-02');
  assert.strictEqual(r.status, 'pass', r.detail);
});

test('V-02 fails when the count floats above/below the value', async () => {
  const r = await run(item('position:relative;top:-9px'), 'V-02');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /above|below/);
});

test('V-07 fails when the checkbox is a rectangle, passes when square', async () => {
  const bad = await run(item('', 'width:22px;height:12px'), 'V-07');
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.detail, /not square/);
  const good = await run(item('', 'width:14px;height:14px'), 'V-07');
  assert.strictEqual(good.status, 'pass', good.detail);
});

const searchBox = (pad) => wrap(`<div style="position:relative;width:300px"><svg width="16" height="16" style="position:absolute;left:8px;top:8px"><circle cx="8" cy="8" r="6" stroke="#000" fill="none"/></svg><input type="text" placeholder="Search in this collection" style="width:300px;height:32px;box-sizing:border-box;padding-left:${pad}px;font:14px Arial"></div>`);

test('V-01 fails when the icon sits on the placeholder, passes with room', async () => {
  const bad = await run(searchBox(0), 'V-01');
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.detail, /touches or overlaps/);
  const good = await run(searchBox(34), 'V-01');
  assert.strictEqual(good.status, 'pass', good.detail);
});

test('V-01 notices a missing icon', async () => {
  const r = await run(wrap('<input type="text" placeholder="Search filter value" style="width:300px;padding-left:10px">'), 'V-01');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /no magnifier/);
});

test('V-03 fails when the hovered count is black on a black hover background', async () => {
  const html = wrap('<div data-tc-hover="1" style="background:#000"><span class="fdt-option-item-count" style="color:#111">(5)</span></div>');
  const r = await run(html, 'V-03');
  assert.strictEqual(r.status, 'fail');
  const ok = await run(wrap('<div data-tc-hover="1" style="background:#000"><span class="fdt-option-item-count" style="color:#fff">(5)</span></div>'), 'V-03');
  assert.strictEqual(ok.status, 'pass', ok.detail);
});

test('V-05 needs a visible arrow on the same line as the group name', async () => {
  const row = (btn) => wrap(`<ul style="margin:0;padding:0;list-style:none"><li class="fdt-group-value__parent-item" style="display:flex;align-items:center"><label style="display:flex;align-items:center"><input type="checkbox"><span class="search-filters__filter-option-item-label">Group Name</span></label>${btn}</li></ul>`);
  const good = await run(row('<button class="fdt-group-value__toggle" style="width:20px;height:20px;border:0;background:#fff;color:#000"><svg width="10" height="6"><path d="M0 0L5 5L10 0" fill="currentColor"/></svg></button>'), 'V-05');
  assert.strictEqual(good.status, 'pass', good.detail);
  const hidden = await run(row('<button class="fdt-group-value__toggle" style="width:20px;height:20px;border:0;background:#000;color:#000"><svg width="10" height="6"><path d="M0 0L5 5L10 0" fill="currentColor"/></svg></button>'), 'V-05');
  assert.strictEqual(hidden.status, 'fail');
  assert.match(hidden.detail, /cannot be seen/);
  const none = await run(row('<button class="fdt-group-value__toggle" style="width:20px;height:20px"></button>'), 'V-05');
  assert.strictEqual(none.status, 'fail');
});

test('V-06 fails when only a circle shows, or both scroll buttons show', async () => {
  const circle = await run('<fdt-scroll-to-top style="display:block;position:fixed;right:20px;bottom:20px;width:40px;height:40px;border-radius:50%;background:#000"></fdt-scroll-to-top>', 'V-06');
  assert.strictEqual(circle.status, 'fail');
  assert.match(circle.detail, /no arrow/);
  const full = await run('<fdt-scroll-to-top style="display:block;position:fixed;right:20px;bottom:20px;width:40px;height:40px;border-radius:50%;background:#000"><svg width="14" height="14"><path d="M7 0L14 14H0Z" fill="#fff"/></svg></fdt-scroll-to-top>', 'V-06');
  assert.strictEqual(full.status, 'pass', full.detail);
  const both = await run('<fdt-scroll-to-top style="display:block;position:fixed;right:20px;bottom:20px;width:40px;height:40px"><svg width="14" height="14"><path d="M7 0L14 14H0Z"/></svg></fdt-scroll-to-top><a class="back-to-top" style="position:fixed;right:20px;bottom:80px;width:30px;height:30px;background:#333;display:block"></a>', 'V-06');
  assert.strictEqual(both.status, 'fail');
  assert.match(both.detail, /same time/);
});

test('V-08 fails when the Sort label floats away from its dropdown', async () => {
  const mk = (off) => wrap(`<div><div class="search-filters__sorting" style="display:flex;align-items:center"><strong class="search-filters__sort-label" style="position:relative;top:${off}px">Sort by</strong><span class="search-filters__sort-button" style="display:inline-block;border:1px solid #000;padding:6px 12px;margin-left:8px">What's new</span></div></div>`);
  assert.strictEqual((await run(mk(0), 'V-08')).status, 'pass');
  const bad = await run(mk(-14), 'V-08');
  assert.strictEqual(bad.status, 'fail');
});

test('O-03 fails when the drawer X is off-centre inside its box', async () => {
  const mk = (dx) => wrap(`<filter-option style="display:block;width:100px;height:30px">Vendor</filter-option><button class="search-filters__close" style="position:relative;width:40px;height:40px;padding:0;border:1px solid #000"><svg width="16" height="16" style="position:absolute;left:${12 + dx}px;top:12px"><path d="M0 0L16 16M16 0L0 16" stroke="#000"/></svg></button>`);
  assert.strictEqual((await run(mk(0), 'O-03')).status, 'pass');
  const bad = await run(mk(12), 'O-03');
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.detail, /off-centre/);
});

test('suggestion: Findter widget plus theme box at the same time is detected', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<input type="search" style="width:600px;display:block;margin:20px"><div class="predictive-search" style="height:120px"><a href="/products/x" style="display:block;height:30px">Theme product</a></div><fdt-search-suggestion-widget style="display:block;width:420px;height:200px">Powered by Findter</fdt-search-suggestion-widget>`);
  const m = await page.evaluate(measureSuggestion, { opts: {} });
  await page.close();
  assert.strictEqual(m.widget, true);
  assert.strictEqual(m.watermark, true);
  assert.ok(m.themeBoxes >= 1);
  assert.ok(m.widthDiffPct > 10);
});

test('V-09 measures where the option text sits in its box (default left alignment is not a bug)', async () => {
  const card = (css) => `<div class="search-filters__product-item" data-tc-card="1" style="width:300px;position:relative"><div class="variant-picker"><label class="option-value" style="display:block;width:200px;height:36px;border:1px solid #000;${css}">M</label></div></div>`;
  const centred = await run(wrap(card('text-align:center;line-height:36px')), 'V-09');
  assert.strictEqual(centred.status, 'pass', centred.detail);
  const left = await run(wrap(card('text-align:left;line-height:36px')), 'V-09');
  assert.strictEqual(left.status, 'fail');
  assert.match(left.detail, /off-centre sideways \(aligned left\)/);
  const right = await run(wrap(card('text-align:right;line-height:36px')), 'V-09');
  assert.match(right.detail, /aligned right/);
  const top = await run(wrap(card('text-align:center;line-height:14px')), 'V-09');
  assert.match(top.detail, /vertically \(aligned top\)/);
});

test('O-03 ignores the page-wide overlay and judges the small close button', async () => {
  const html = wrap(`<filter-option style="display:block;width:100px;height:30px">Vendor</filter-option>
    <div class="search-filters__close-overlay" style="position:fixed;left:0;top:0;width:1000px;height:60px"></div>
    <button class="search-filters__close" style="position:relative;width:40px;height:40px;padding:0;border:1px solid #000"><svg width="16" height="16" style="position:absolute;left:12px;top:12px"><path d="M0 0L16 16M16 0L0 16" stroke="#000"/></svg></button>`);
  const r = await run(html, 'O-03');
  assert.strictEqual(r.status, 'pass', r.detail);
});

test('the layout is read from Findter\'s own class, also when the horizontal bar wraps to two rows', async () => {
  const { detectLayout } = require('../src/checks/run');
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent('<div class="search-filters__layout fdt-layout-horizontal"><filter-option style="display:block">A</filter-option><filter-option style="display:block;margin-top:80px">B</filter-option></div>');
  assert.strictEqual(await detectLayout(page), 'horizontal');
  await page.setContent('<div class="search-filters__layout fdt-layout-offcanvas"></div>');
  assert.strictEqual(await detectLayout(page), 'offcanvas');
  await page.close();
});

test('V-09 / M-04 measure the option buttons only, never a caption line such as "Title: Sample Selling Plans"', async () => {
  const card = (caption) => `<div class="search-filters__product-item" data-tc-card="1" style="width:300px;position:relative"><div class="variant-picker">
    <span class="option-label" style="display:block;text-align:left">Size: 10</span>
    <label class="option-value" style="display:inline-block;width:60px;height:32px;border:1px solid #000;border-radius:16px;text-align:center;line-height:32px">10</label>
    <label class="option-value" style="display:inline-block;width:60px;height:32px;border:1px solid #000;border-radius:16px;text-align:center;line-height:32px">12</label>
    ${caption}
    <button style="display:block;width:280px;height:36px;border:1px solid #000">Add to cart</button></div></div>`;
  // a wide caption line with no border and no background, aligned left: it is text, not a button
  const withCaption = await run(wrap(card('<label class="option-title" style="display:block;width:260px">Title: Sample Selling Plans</label>')), 'V-09');
  assert.strictEqual(withCaption.status, 'pass', withCaption.detail);
  const mobile = await run(wrap(card('<label class="variant-title" style="display:block;width:260px">Title: Sample Selling Plans</label>')), 'M-04');
  assert.strictEqual(mobile.status, 'pass', mobile.detail);
  // a real pill with its text pushed to the left is still caught
  const bad = await run(wrap(card('<label class="option-value" style="display:block;width:200px;height:36px;border:1px solid #000;text-align:left;line-height:36px">XL</label>')), 'V-09');
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.detail, /option "XL".*off-centre sideways/);
});

test('V-12 measures every Findter icon: normal ones pass, an enlarged or empty one fails', async () => {
  const icon = (w, h, shape) => `<svg width="${w}" height="${h}" viewBox="0 0 20 20" style="display:inline-block">${shape === 'empty' ? '' : '<path d="M2 2h16v16H2z" fill="#000"/>'}</svg>`;
  const good = await run(wrap(icon(16, 16) + icon(20, 20) + icon(12, 12)), 'V-12');
  assert.strictEqual(good.status, 'pass', good.detail);
  assert.match(good.detail, /3 Findter icon\(s\) measured/);
  const big = await run(wrap(icon(16, 16) + icon(120, 120)), 'V-12');
  assert.strictEqual(big.status, 'fail');
  assert.match(big.detail, /enlarged \(120x120px/);
  const empty = await run(wrap(icon(16, 16, 'empty')), 'V-12');
  assert.strictEqual(empty.status, 'fail');
  assert.match(empty.detail, /empty/);
  assert.strictEqual((await run('<p>no icons</p>', 'V-12')).status, 'na');
});

test('suggestion: the panel on screen counts, not the size-less tag; a widget in a hidden copy of the form is named as such', async () => {
  const mobileLike = `<form style="display:block"><fdt-search-suggestion-widget><fdt-search-suggestion><fdt-search-suggestion-overview style="display:block;position:absolute;left:0;top:0;width:390px;height:600px"><button class="search-filters__search-suggestion-close-button" style="width:33px;height:25px"><svg width="20" height="20"><path d="M0 0h20v20z"/></svg></button><div>Products</div><fdt-watermark style="display:block"><span>Powered by Findter</span></fdt-watermark></fdt-search-suggestion-overview></fdt-search-suggestion></fdt-search-suggestion-widget></form>`;
  let page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await page.setContent(`<body>${mobileLike}`);
  let m = await page.evaluate(measureSuggestion, { opts: {} });
  await page.close();
  assert.strictEqual(m.widget, true, 'the panel is on screen although the widget tag itself has no size');
  assert.strictEqual(m.watermark, true);
  assert.strictEqual(m.backArrow, true);
  // desktop Dawn: Findter's widget sits in a copy of the search form that is not shown
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.setContent(`<body><form style="display:none"><fdt-search-suggestion-widget><fdt-search-suggestion><fdt-search-suggestion-overview style="position:absolute"><div>Products</div><fdt-watermark>Powered by Findter</fdt-watermark></fdt-search-suggestion-overview></fdt-search-suggestion></fdt-search-suggestion-widget></form><form><input type="search" style="width:500px"><div class="predictive-search" style="height:120px"><a href="/products/x" style="display:block;height:30px">Theme product</a></div></form>`);
  m = await page.evaluate(measureSuggestion, { opts: {} });
  await page.close();
  assert.strictEqual(m.widget, false);
  assert.strictEqual(m.hiddenCopy, true);
  assert.ok(m.themeBoxes >= 1);
});

test("the search bars counted after the back arrow are the shopper's, not the collection filter boxes", async () => {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await page.setContent(`<body><input type="search" style="width:300px"><div id="fdt-container"><input type="text" placeholder="Search in this collection"><input type="text" placeholder="Search filter value"></div>`);
  const m = await page.evaluate(measureSuggestion, { opts: {} });
  await page.close();
  assert.strictEqual(m.searchInputs, 1);
});
