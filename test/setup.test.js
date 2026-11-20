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
