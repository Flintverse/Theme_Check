// The theme editor setup is proved before any test: Findter must really show on the storefront.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { chromium } = require('playwright-core');
const { waitFindter } = require('../src/checks/run');

function server(handler) {
  const srv = http.createServer(handler);
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('pictures: a screenshot that fails is tried again; one that cannot be saved is not listed (no broken image with only a file name)', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Pass } = require('../src/checks/run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shot-'));
  let calls = 0;
  const slowPage = { screenshot: async (o) => { calls++; if (calls < 3) throw new Error('page.screenshot: Timeout 8000ms exceeded'); fs.writeFileSync(o.path, 'png'); }, waitForTimeout: async () => {} };
  const p = new Pass({ page: slowPage, outDir: dir, relDir: 'craft/search-desktop', layout: 'search', viewport: {}, thresholds: {} });
  const rel = await p.shot('search-typed');
  assert.strictEqual(rel, 'craft/search-desktop/01-search-typed.png');
  assert.ok(fs.existsSync(path.join(dir, rel)), 'saved on the third try');
  assert.strictEqual(calls, 3);
  const deadPage = { screenshot: async () => { throw new Error('Target closed'); }, waitForTimeout: async () => {} };
  const q = new Pass({ page: deadPage, outDir: dir, relDir: 'craft/other', layout: 'search', viewport: {}, thresholds: {} });
  const none = await q.shot('x');
  assert.strictEqual(none, null);
  assert.strictEqual(q.shotsLost, 1);
  q.add('S-05', 'review', 'look', [none, rel]);
  assert.deepStrictEqual(q.results[0].shots, [rel], 'only a picture that exists is listed');
});

test('settleLayout: a layout that was saved a moment ago is waited for (page reloaded) before it counts as not applied', async () => {
  const { settleLayout } = require('../src/checks/run');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let loads = 0;
  const srv = await server((req, res) => { if (/favicon/.test(req.url)) { res.writeHead(404); return res.end(); } loads++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><body><div id="fdt-container"><div class="search-filters__layout fdt-layout-${loads >= 3 ? 'horizontal' : 'vertical'}">x</div></div><div class="search-filters__product-item">card</div>`); });
  const url = `http://127.0.0.1:${srv.address().port}/collections/all`;
  try {
    const page = await browser.newPage();
    await page.goto(url);
    assert.strictEqual(await settleLayout(page, 'horizontal', { url, waitMs: 50 }), 'horizontal', 'the storefront showed vertical for two loads, then the saved horizontal');
    assert.strictEqual(loads, 3);
    loads = 0;
    // (a browser may also ask for /favicon.ico: that is not a page load)
    await page.goto(url);
    assert.strictEqual(await settleLayout(page, 'offcanvas', { url, waitMs: 50, tries: 2 }), 'horizontal', 'a layout that never arrives is still reported as what the page shows (so G-04 fails)');
  } finally { srv.close(); await browser.close(); }
});

test('waitFindter: a theme that does not draw Findter on /collections/all is tried on a real collection from the menu', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const srv = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.startsWith('/collections/accessory')) res.end('<!doctype html><body><div id="fdt-container">filters</div>');
    else res.end('<!doctype html><body><a href="/collections/all">All</a><a href="/collections/accessory">Accessory</a><main>no Findter here</main>');
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await waitFindter({ browser, url: base + '/collections/all', maxMs: 20000, selectorMs: 600, pollMs: 200 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, base + '/collections/accessory');
    assert.match(r.note, /not drawn on \/collections\/all/);
  } finally { srv.close(); await browser.close(); }
});

test('waitFindter: ok as soon as the Findter container shows; a clear reason when it never does; a password page is named', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const html = (body) => (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><body>${body}`); };
  let late = 0;
  const withFindter = await server(html('<div id="fdt-container">filters</div>'));
  const without = await server(html('<main>a theme collection page with no Findter</main>'));
  const gate = await server(html('<form action="/password" method="post"><input type="password" name="password"><button>Enter</button></form>'));
  const appearsLater = await server((req, res) => { late++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><body>${late >= 2 ? '<div id="fdt-container">ok</div>' : '<p>not yet</p>'}`); });
  const url = (s) => `http://127.0.0.1:${s.address().port}/collections/all`;
  try {
    const a = await waitFindter({ browser, url: url(withFindter), maxMs: 30000 });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.looks, 1);
    const b = await waitFindter({ browser, url: url(without), maxMs: 1000, selectorMs: 800, pollMs: 200 });
    assert.strictEqual(b.ok, false);
    assert.match(b.detail, /Findter's container \(#fdt-container\) is not on the collection page/);
    const c = await waitFindter({ browser, url: url(gate), maxMs: 5000, selectorMs: 800, pollMs: 200 });
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.blocked, true);
    // it keeps looking: the container shows from the second look on
    const d = await waitFindter({ browser, url: url(appearsLater), maxMs: 30000, selectorMs: 600, pollMs: 200 });
    assert.strictEqual(d.ok, true);
    assert.ok(d.looks >= 2, 'found on look ' + d.looks);
    assert.match(c.detail, /password/i);
  } finally { [withFindter, without, gate, appearsLater].forEach((s) => s.close()); await browser.close(); }
});
