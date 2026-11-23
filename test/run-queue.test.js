// "Run test": choose themes, a store and a browser and press Run. One run per store at a time; runs in different stores go on
// together; nothing that is already running is ever touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const q = require('../src/run-queue');
const { Progress, readAllProgress, envRunning } = require('../src/store/progress');
const agent = require('../src/agent');

const SRC = path.resolve(__dirname, '..');
const CFG = { envs: { staging: {}, prod: {} }, cloudflare: { url: 'https://x.dev' } };

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rq-'));
  fs.cpSync(path.join(SRC, 'checklist'), path.join(r, 'checklist'), { recursive: true });
  fs.mkdirSync(path.join(r, 'config'), { recursive: true });
  fs.writeFileSync(path.join(r, 'config', 'themes.json'), JSON.stringify({ themes: [
    { name: 'Dawn', envs: ['staging', 'prod'], batch: 1, enabled: true },
    { name: 'Craft', envs: ['staging', 'prod'], batch: 1, enabled: true },
    { name: 'Be Yours', envs: ['staging'], batch: 1, enabled: true },
    { name: 'Off', envs: ['staging'], batch: 1, enabled: false },
  ] }));
  fs.mkdirSync(path.join(r, '.profile-staging'));
  return r;
}
const dataOf = (root) => path.join(root, 'history', 'data');
const fakeSpawn = () => { const calls = []; let pid = 4000; const fn = (exe, args, req) => { calls.push({ args, req }); return process.pid + 0 * (pid++); }; fn.calls = calls; return fn; }; // a pid that is alive

test('progress: one file per store, so two runs do not overwrite each other; the page gets a stable order', () => {
  const root = tmpRoot();
  const a = new Progress(dataOf(root), { runId: 'r-stg', env: 'staging', startedAt: '2026-11-23T01:00:00Z' });
  const b = new Progress(dataOf(root), { runId: 'r-prod', env: 'prod', startedAt: '2026-11-23T02:00:00Z' });
  a.setThemes([{ name: 'Dawn', batch: 1 }]); b.setThemes([{ name: 'Craft', batch: 1 }]);
  assert.ok(fs.existsSync(path.join(dataOf(root), 'progress-staging.json')));
  assert.ok(fs.existsSync(path.join(dataOf(root), 'progress-prod.json')));
  const all = readAllProgress(dataOf(root));
  assert.deepStrictEqual(all.map((p) => p.env), ['staging', 'prod'], 'both are running: the one that started first stays on top');
  assert.strictEqual(envRunning(dataOf(root), 'prod'), true);
  b.finish('completed');
  assert.strictEqual(envRunning(dataOf(root), 'prod'), false);
  assert.strictEqual(envRunning(dataOf(root), 'staging'), true);
  // the older single progress.json (written by a run started before this version) still counts
  fs.writeFileSync(path.join(dataOf(root), 'progress.json'), JSON.stringify({ running: true, pid: process.pid, runId: 'old', env: 'dev', themes: [], events: [], totals: {}, startedAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z' }));
  assert.ok(readAllProgress(dataOf(root)).some((p) => p.env === 'dev' && p.running));
});

test('queue: only themes of that store\'s list, a known store and browser; names are cleaned', () => {
  const root = tmpRoot();
  assert.match(q.add(root, CFG, { env: 'nope', themes: ['Dawn'] }).error, /Unknown testing environment/);
  assert.match(q.add(root, CFG, { env: 'staging', browser: 'firefox', themes: ['Dawn'] }).error, /Browser/);
  assert.match(q.add(root, CFG, { env: 'staging', themes: [] }).error, /at least one theme/);
  assert.match(q.add(root, CFG, { env: 'staging', themes: ['Nope'] }).error, /not in the staging theme list/);
  assert.match(q.add(root, CFG, { env: 'staging', themes: ['Off'] }).error, /not in the staging theme list/, 'a switched-off theme is not in the list');
  assert.match(q.add(root, CFG, { env: 'prod', themes: ['Be Yours'] }).error, /not in the prod theme list/, 'the lists are per store');
  assert.match(q.add(root, CFG, { env: 'staging', themes: ['Dawn; rm -rf /'] }).error, /valid theme name/);
  const ok = q.add(root, CFG, { env: 'staging', browser: 'msedge', themes: ['dawn', ' be   yours ', 'Dawn'] }, 'someone@x.com');
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.request.themes, ['Dawn', 'Be Yours'], 'the names of the list, each once');
  assert.strictEqual(ok.request.status, 'queued');
});

test('queue: a free store starts at once, in parallel with another store; a busy store waits and nothing is stopped', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.profile-prod'));
  // a run is going on in staging (a live process, started by hand or by the schedule)
  new Progress(dataOf(root), { runId: 'live-stg', env: 'staging' }).setThemes([{ name: 'Atelier', batch: 1 }]);
  const spawnFn = fakeSpawn();
  const a = q.add(root, CFG, { env: 'staging', themes: ['Dawn'] }).request;
  const b = q.add(root, CFG, { env: 'prod', themes: ['Craft'], browser: 'chrome' }).request;
  const started = q.startDue(root, CFG, { spawnFn });
  assert.deepStrictEqual(started.map((r) => r.id), [b.id], 'prod starts now');
  assert.strictEqual(spawnFn.calls.length, 1);
  const args = spawnFn.calls[0].args;
  assert.deepStrictEqual(args.slice(1, 7), ['run', '--env', 'prod', '--themes', 'Craft', '--label']);
  assert.ok(args.includes('--browser') && args[args.indexOf('--browser') + 1] === 'chrome');
  assert.ok(args.includes('--no-tracker'), 'a hand-picked test does not touch the issue tracker unless asked');
  assert.strictEqual(q.get(root, a.id).status, 'queued', 'staging is busy: it waits');
  assert.match(q.get(root, a.id).note, /Waiting: another run is going on in the staging store/);
  assert.strictEqual(q.get(root, b.id).status, 'running');
  // asking again changes nothing, and does not start the second prod request while the first one runs
  const c = q.add(root, CFG, { env: 'prod', themes: ['Dawn'] }).request;
  assert.strictEqual(q.startDue(root, CFG, { spawnFn }).length, 0);
  assert.strictEqual(q.get(root, c.id).status, 'queued');
  // the staging run ends: the waiting request starts by itself
  fs.rmSync(path.join(dataOf(root), 'progress-staging.json'));
  const later = q.startDue(root, CFG, { spawnFn });
  assert.deepStrictEqual(later.map((r) => r.id), [a.id]);
});

test('queue: the same request is never started twice; a store with no saved login is refused with the command to fix it; cancel only before it starts', () => {
  const root = tmpRoot();
  const spawnFn = fakeSpawn();
  const a = q.add(root, CFG, { env: 'staging', themes: ['Dawn'] }).request;
  fs.writeFileSync(path.join(root, 'history', 'queue', a.id + '.claim'), ''); // another process (agent / local dashboard) already took it
  assert.strictEqual(q.startDue(root, CFG, { spawnFn }).length, 0, 'the claim file keeps a second process from starting it');
  fs.rmSync(path.join(root, 'history', 'queue', a.id + '.claim'));
  q.cancel(root, a.id);
  assert.strictEqual(q.get(root, a.id).status, 'cancelled');
  assert.match(q.cancel(root, a.id).error, /already cancelled/);
  // Edge was never logged in on this machine
  const e = q.add(root, CFG, { env: 'staging', browser: 'msedge', themes: ['Dawn'] }).request;
  assert.strictEqual(q.startDue(root, CFG, { spawnFn }).length, 0);
  assert.strictEqual(q.get(root, e.id).status, 'rejected');
  assert.match(q.get(root, e.id).note, /No saved Shopify login for staging in Microsoft Edge.*--browser msedge/);
  // a started request cannot be cancelled
  const r = q.add(root, CFG, { env: 'staging', themes: ['Craft'] }).request;
  q.startDue(root, CFG, { spawnFn });
  assert.match(q.cancel(root, r.id).error, /never stopped/);
});

test('queue: a request whose process is gone is finished (done when the run completed, failed otherwise) and gets its run id', () => {
  const root = tmpRoot();
  const a = q.add(root, CFG, { env: 'staging', themes: ['Dawn'] }).request;
  const r = q.get(root, a.id); r.status = 'running'; r.pid = 2147483000; q.save(root, r); // not alive
  const p = new Progress(dataOf(root), { runId: '2026-11-23-staging-' + r.label, env: 'staging' });
  p.setThemes([{ name: 'Dawn', batch: 1 }]); p.finish('completed');
  q.reconcile(root, CFG);
  assert.strictEqual(q.get(root, a.id).status, 'done');
  assert.strictEqual(q.get(root, a.id).runId, '2026-11-23-staging-' + r.label);
  const b = q.add(root, CFG, { env: 'prod', themes: ['Craft'] }).request;
  const r2 = q.get(root, b.id); r2.status = 'running'; r2.pid = 2147483000; q.save(root, r2);
  q.reconcile(root, CFG);
  assert.strictEqual(q.get(root, b.id).status, 'failed');
  assert.match(q.get(root, b.id).note, /before it reported any progress/);
});

test('agent: takes a request made on the web page, checks it again, queues or rejects it, honours a cancel, and reports every change', async () => {
  const root = tmpRoot();
  const old = process.env.THEME_CHECK_TOKEN; process.env.THEME_CHECK_TOKEN = 'tok-tok-tok-tok-1234';
  const posted = {};
  const remote = [
    { id: 'w1', env: 'staging', browser: 'chrome', themes: ['Dawn', 'Craft'], status: 'requested', requestedBy: 'dungnn@bsscommerce.com', requestedAt: '2026-11-23T03:00:00Z' },
    { id: 'w2', env: 'staging', browser: 'chrome', themes: ['Nope'], status: 'requested', requestedBy: 'x@bsscommerce.com', requestedAt: '2026-11-23T03:01:00Z' },
    { id: 'w3', env: 'prod', browser: 'chrome', themes: ['Craft'], status: 'requested', requestedBy: 'x@bsscommerce.com', requestedAt: '2026-11-23T03:02:00Z' },
  ];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (init && init.method === 'POST') { // the web copy keeps what the machine reports, so a rejected request is no longer "requested"
      const doc = JSON.parse(init.body);
      posted[decodeURIComponent(u.pathname.split('/').pop())] = doc;
      const i = remote.findIndex((x) => x.id === doc.id);
      if (i >= 0) remote[i] = Object.assign({}, remote[i], doc, { cancelRequested: remote[i].cancelRequested });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ requests: remote }) };
  };
  try {
    new Progress(dataOf(root), { runId: 'busy', env: 'staging' }).setThemes([{ name: 'X', batch: 1 }]); // staging is busy
    const r1 = await agent.syncRunRequests(root, CFG, { fetchImpl, startDue: (rt, c) => q.startDue(rt, c, { spawnFn: fakeSpawn() }) });
    assert.strictEqual(r1.taken, 2, 'w1 and w3 are taken');
    assert.strictEqual(r1.rejected, 1, 'w2 names a theme that is not in the list');
    assert.strictEqual(posted.w2.status, 'rejected');
    assert.match(posted.w2.note, /not in the staging theme list/);
    assert.strictEqual(posted.w1.status, 'queued', 'staging is busy: queued, reported back');
    assert.match(posted.w1.note, /Waiting/);
    assert.strictEqual(posted.w3.status, 'rejected', 'prod has no saved login on this machine');
    assert.match(posted.w3.note, /No saved Shopify login for prod/);
    // the page cancels w1 before it started
    remote[0] = Object.assign({}, remote[0], { status: 'queued', cancelRequested: true });
    const r2 = await agent.syncRunRequests(root, CFG, { fetchImpl, startDue: () => [] });
    assert.strictEqual(r2.cancelled, 1);
    assert.strictEqual(q.get(root, 'w1').status, 'cancelled');
    assert.strictEqual(posted.w1.status, 'cancelled');
    // nothing changed: nothing is sent again
    Object.keys(posted).forEach((k) => delete posted[k]);
    await agent.syncRunRequests(root, CFG, { fetchImpl, startDue: () => [] });
    assert.deepStrictEqual(Object.keys(posted), [], 'only changes are reported');
  } finally { if (old === undefined) delete process.env.THEME_CHECK_TOKEN; else process.env.THEME_CHECK_TOKEN = old; }
});

test('Cloudflare: only editors can ask for a test or cancel it; anyone signed in can look; the machine reads the requests and the progress of every store', async () => {
  const store = new Map();
  const R2 = {
    async put(k, v) { store.set(k, String(v)); },
    async get(k) { return store.has(k) ? { body: store.get(k), text: async () => store.get(k) } : null; },
    async delete(k) { (Array.isArray(k) ? k : [k]).forEach((x) => store.delete(x)); },
    async list({ prefix }) { return { objects: Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
  };
  const env = { STORE: R2, INGEST_TOKEN: 'ingest-token-1234567', SESSION_SECRET: 's'.repeat(40), EDITORS: 'dungnn@bsscommerce.com', ALLOWED_DOMAIN: 'bsscommerce.com' };
  const lib = await import(pathToFileURL(path.join(SRC, 'cf/lib.js')).href);
  const fn = await import(pathToFileURL(path.join(SRC, 'functions/api/run-request.js')).href);
  const prog = await import(pathToFileURL(path.join(SRC, 'functions/api/progress.js')).href);
  const plist = await import(pathToFileURL(path.join(SRC, 'functions/api/progress-list.js')).href);
  const ingest = await import(pathToFileURL(path.join(SRC, 'functions/api/ingest/[[path]].js')).href);
  const cookie = async (email) => 'tc_session=' + (await lib.makeSession(env, { email, name: 'x' }));
  const req = async (method, who, body, qs) => new Request('https://x.dev/api/run-request' + (qs || ''), { method, headers: Object.assign({ 'content-type': 'application/json' }, who ? { cookie: await cookie(who) } : {}), body: body ? JSON.stringify(body) : undefined });
  const good = { env: 'staging', browser: 'msedge', themes: ['Dawn', 'Craft'] };
  assert.strictEqual((await fn.onRequestPost({ request: await req('POST', null, good), env })).status, 403, 'nobody signed in');
  assert.strictEqual((await fn.onRequestPost({ request: await req('POST', 'other@bsscommerce.com', good), env })).status, 403, 'signed in but not an editor');
  assert.strictEqual((await fn.onRequestPost({ request: await req('POST', 'dungnn@bsscommerce.com', { env: 'staging', themes: [] }), env })).status, 400);
  assert.strictEqual((await fn.onRequestPost({ request: await req('POST', 'dungnn@bsscommerce.com', { env: 'staging', themes: ['x<script>'] }), env })).status, 400);
  assert.strictEqual((await fn.onRequestPost({ request: await req('POST', 'dungnn@bsscommerce.com', { env: 'staging', browser: 'ie', themes: ['Dawn'] }), env })).status, 400);
  const made = await (await fn.onRequestPost({ request: await req('POST', 'dungnn@bsscommerce.com', good), env })).json();
  assert.ok(made.ok && made.id);
  // anyone signed in can look
  assert.strictEqual((await fn.onRequestGet({ request: await req('GET', null), env })).status, 401);
  const seen = await (await fn.onRequestGet({ request: await req('GET', 'other@bsscommerce.com'), env })).json();
  assert.strictEqual(seen.requests[0].status, 'requested');
  assert.deepStrictEqual(seen.requests[0].themes, ['Dawn', 'Craft']);
  // the machine reads it (token), and writes back what became of it
  const call = (m, p, body) => ingest[m === 'GET' ? 'onRequestGet' : m === 'DELETE' ? 'onRequestDelete' : 'onRequestPost']({ request: new Request('https://x.dev/api/ingest/' + p, { method: m, headers: { authorization: 'Bearer ' + env.INGEST_TOKEN }, body: body ? JSON.stringify(body) : undefined }), env, params: { path: p.split('?')[0].split('/') } });
  const mine = await (await call('GET', 'run-requests')).json();
  assert.strictEqual(mine.requests.length, 1);
  assert.strictEqual((await call('POST', 'run-requests/' + made.id, Object.assign({}, mine.requests[0], { status: 'queued', note: 'Waiting' }))).status, 200);
  assert.strictEqual((await call('POST', 'run-requests/other', mine.requests[0])).status, 400, 'the id in the body must match');
  // cancel: editors only, and only before it started; a marker the machine sees
  assert.strictEqual((await fn.onRequestDelete({ request: await req('DELETE', 'other@bsscommerce.com', null, '?id=' + made.id), env })).status, 403);
  assert.strictEqual((await fn.onRequestDelete({ request: await req('DELETE', 'dungnn@bsscommerce.com', null, '?id=' + made.id), env })).status, 200);
  const after = await (await call('GET', 'run-requests')).json();
  assert.strictEqual(after.requests[0].cancelRequested, true);
  assert.strictEqual(after.requests[0].status, 'queued', 'the machine\'s state is not overwritten by the marker');
  await call('POST', 'run-requests/' + made.id, Object.assign({}, after.requests[0], { status: 'running' }));
  assert.strictEqual((await fn.onRequestDelete({ request: await req('DELETE', 'dungnn@bsscommerce.com', null, '?id=' + made.id), env })).status, 409, 'a run in progress is never stopped from the web');
  // progress of two stores: each in its own file; the page can ask for either; the one that is running comes first
  await call('POST', 'progress/staging', { running: true, env: 'staging', runId: 'a', startedAt: '2026-11-23T01:00:00Z', updatedAt: new Date().toISOString(), themes: [] });
  await call('POST', 'progress/prod', { running: true, env: 'prod', runId: 'b', startedAt: '2026-11-23T02:00:00Z', updatedAt: new Date().toISOString(), themes: [] });
  assert.ok(store.has('data/progress-staging.json') && store.has('data/progress-prod.json'));
  const get = (u) => new Request('https://x.dev' + u, { headers: { cookie: '' } });
  const withCookie = async (u) => new Request('https://x.dev' + u, { headers: { cookie: await cookie('other@bsscommerce.com') } });
  assert.strictEqual((await (await prog.onRequestGet({ request: await withCookie('/api/progress'), env })).json()).runId, 'a', 'the run that started first');
  assert.strictEqual((await (await prog.onRequestGet({ request: await withCookie('/api/progress?env=prod'), env })).json()).runId, 'b');
  assert.deepStrictEqual((await (await plist.onRequestGet({ request: await withCookie('/api/progress-list'), env })).json()).runs.map((x) => x.env), ['staging', 'prod']);
  assert.strictEqual((await call('POST', 'progress/bad name', {})).status, 400);
  // forgetting the progress of one run (any store) leaves a run that is going alone
  assert.strictEqual((await (await call('DELETE', 'progress?run=a')).json()).removed, 0, 'a run that is still going is kept');
  await call('POST', 'progress/staging', { running: false, env: 'staging', runId: 'a', updatedAt: new Date().toISOString(), themes: [] });
  assert.strictEqual((await (await call('DELETE', 'progress?run=a')).json()).removed, 1);
  assert.strictEqual(store.has('data/progress-staging.json'), false);
  assert.strictEqual(store.has('data/progress-prod.json'), true);
});

test('local dashboard: request, list, cancel and the store switch work over its own endpoints, with the local-only header', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'config', 'config.example.json'), JSON.stringify({ envs: { staging: { shop: 's' }, prod: { shop: 'p' } } }));
  fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ui', 'index.html'), 'x');
  const { listen } = require('../src/server');
  const srv = await listen(root, 0, { spawnRun: false });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, p, body, hdr) => { const r = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, hdr === false ? {} : { 'x-tc': '1' }), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.strictEqual((await call('POST', '/api/run-request', { env: 'staging', themes: ['Dawn'] }, false)).status, 403, 'a page on another site cannot start a test');
    assert.strictEqual((await call('POST', '/api/run-request', { env: 'staging', themes: ['Nope'] })).status, 400);
    const made = await call('POST', '/api/run-request', { env: 'staging', browser: 'chrome', themes: ['Dawn', 'Craft'], tracker: false });
    assert.strictEqual(made.status, 200);
    assert.strictEqual(made.body.request.status, 'queued', 'spawnRun is off in this test: nothing is started');
    const list = (await call('GET', '/api/run-request')).body;
    assert.strictEqual(list.requests.length, 1);
    assert.deepStrictEqual(Object.keys(list.browsers), ['chrome', 'msedge']);
    assert.strictEqual((await call('DELETE', '/api/run-request?id=' + made.body.request.id)).status, 200);
    assert.strictEqual((await call('DELETE', '/api/run-request?id=' + made.body.request.id)).status, 409, 'already cancelled');
    new Progress(path.join(root, 'history', 'data'), { runId: 'a', env: 'staging' }).setThemes([{ name: 'X', batch: 1 }]);
    new Progress(path.join(root, 'history', 'data'), { runId: 'b', env: 'prod' }).setThemes([{ name: 'X', batch: 1 }]);
    assert.deepStrictEqual((await call('GET', '/api/progress-list')).body.runs.map((x) => x.env).sort(), ['prod', 'staging']);
    assert.strictEqual((await call('GET', '/api/progress?env=prod')).body.runId, 'b');
    assert.deepStrictEqual((await call('GET', '/api/run-request')).body.busy.sort(), ['prod', 'staging']);
  } finally { srv.close(); }
});

test('the page: choose themes and press Run test (web copy, editor); filter, select all shown, clear; busy store is explained; requests show with their state and Cancel', async () => {
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const names = ['Dawn', 'Craft', 'Be Yours', 'Horizon'];
  const base = { readOnly: true, mediaLocal: true, envs: ['staging', 'prod'], themes: names.map((n) => ({ name: n, envs: n === 'Horizon' ? ['prod'] : ['staging', 'prod'], batch: 1, enabled: true })), schedule: { enabled: false, mode: 'weekly', weekday: 'MON', everyDays: 7, time: '07:30', env: 'staging', batches: 'all', mail: false, description: 'Off' }, task: null, runs: [], issues: { items: {} }, themeStatus: [], checklist: [], library: {} };
  const st = { posted: null, cancelled: null, busy: ['staging'], requests: [{ id: 'w9', env: 'staging', browser: 'chrome', themes: ['Dawn'], status: 'queued', note: 'Waiting: another run is going on in the staging store.', requestedBy: 'dungnn@bsscommerce.com', requestedAt: '2026-11-23T03:00:00Z' }] };
  const srv = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(200, base);
    if (req.url === '/api/progress') return send(200, { running: false, none: true });
    if (req.url === '/api/me') return send(200, { email: 'dungnn@bsscommerce.com', name: 'Dung', canEdit: true });
    if (req.url === '/api/run-request' && req.method === 'GET') return send(200, { requests: st.requests, busy: st.busy, browsers: { chrome: 'Google Chrome', msedge: 'Microsoft Edge' } });
    if (req.url === '/api/run-request' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }).on('end', () => { st.posted = JSON.parse(b); send(200, { ok: true, id: 'w10' }); }); return; }
    if (req.url.startsWith('/api/run-request?id=') && req.method === 'DELETE') { st.cancelled = new URL(req.url, 'http://x').searchParams.get('id'); return send(200, { ok: true }); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${srv.address().port}/#runtest`);
    await page.waitForSelector('#rt-run');
    await page.waitForFunction(() => !document.querySelector('#rt-run').disabled, null, { timeout: 8000 });
    assert.strictEqual(await page.locator('.rt-t').count(), 3, 'the staging list: Horizon is only in the prod list');
    assert.match(await page.textContent('#rt-busy'), /run is going on in the staging store.*waits in the queue/s, 'a busy store is explained before pressing');
    assert.match(await page.textContent('#rt-reqs'), /QUEUED/);
    assert.match(await page.textContent('#rt-reqs'), /Waiting: another run is going on/);
    // nothing chosen: no request
    await page.click('#rt-run');
    assert.match(await page.textContent('#rt-msg'), /Choose at least one theme/);
    assert.strictEqual(st.posted, null);
    // filter, select all shown, count
    await page.fill('#rt-filter', 'a');
    assert.strictEqual(await page.locator('.rt-t').count(), 2, 'Dawn and Craft contain an a ("Be Yours" does not)');
    await page.click('#rt-all');
    assert.strictEqual((await page.textContent('#rt-count')).trim(), '2 of 3 selected');
    await page.fill('#rt-filter', '');
    await page.check('.rt-t[data-n="Be Yours"]');
    assert.strictEqual((await page.textContent('#rt-count')).trim(), '3 of 3 selected');
    await page.uncheck('.rt-t[data-n="Craft"]');
    await page.selectOption('#rt-browser', 'msedge');
    await page.selectOption('#rt-tracker', '1');
    await page.click('#rt-run');
    await page.waitForFunction(() => /Sent\./.test(document.querySelector('#rt-msg').textContent));
    assert.deepStrictEqual(st.posted, { env: 'staging', browser: 'msedge', themes: ['Dawn', 'Be Yours'], tracker: true });
    assert.strictEqual(await page.locator('.rt-t:checked').count(), 0, 'the choice is cleared after sending');
    // switching the store changes the list and the busy note
    await page.selectOption('#rt-env', 'prod');
    assert.strictEqual(await page.locator('.rt-t').count(), 4, 'prod: Dawn, Craft, Be Yours, Horizon');
    assert.strictEqual((await page.textContent('#rt-busy')).trim(), '', 'prod is free');
    // cancel a queued request
    await page.click('[data-cancel="w9"]');
    await page.waitForFunction(() => /Cancel sent/.test(document.querySelector('#rt-msg').textContent));
    assert.strictEqual(st.cancelled, 'w9');
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
