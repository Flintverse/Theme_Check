// Save once, everything follows: propagate (Task Scheduler, Cloudflare, GitHub), the web editing path, the agent, and UTC+7.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { propagate, gitCommitPush } = require('../src/propagate');
const agent = require('../src/agent');
const T = require('../src/lib/time');
const { buildSummary } = require('../src/store/summary');
const { updateTracker, emptyTracker } = require('../src/store/tracker');
const { flatten } = require('../src/report/compare');
const checklist = require('../checklist/checklist.json');

const SRC = path.resolve(__dirname, '..');
const tmpRoot = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cs-'));
  ['config', 'checklist'].forEach((d) => fs.cpSync(path.join(SRC, d), path.join(r, d), { recursive: true }));
  fs.rmSync(path.join(r, 'config', 'config.local.json'), { force: true });
  return r;
};
const CFG = { envs: { staging: {}, prod: {} }, cloudflare: { url: 'https://x.dev' } };
const ENVV = { THEME_CHECK_TOKEN: 'tok-tok-tok-tok-1234' };
const withEnv = (fn) => async () => { const old = process.env.THEME_CHECK_TOKEN; process.env.THEME_CHECK_TOKEN = ENVV.THEME_CHECK_TOKEN; try { await fn(); } finally { if (old === undefined) delete process.env.THEME_CHECK_TOKEN; else process.env.THEME_CHECK_TOKEN = old; } };

// ---------------- UTC+7
test('times are shown in UTC+7, and a run belongs to its UTC+7 day', () => {
  assert.strictEqual(T.fmtDateTime('2026-11-18T07:25:46Z'), '2026-11-18 14:25:46');
  assert.strictEqual(T.fmtDate('2026-11-18T18:30:00Z'), '2026-11-19', '01:30 the next morning in UTC+7');
  assert.strictEqual(T.fmtTime('2026-11-18T17:05:09Z'), '00:05:09');
  assert.strictEqual(T.fmtStamp('2026-11-18T07:00:00Z'), '2026-11-18 14:00:00 (UTC+7)');
  const run = { runId: 'r', env: 'staging', startedAt: '2026-11-18T18:30:00Z', themes: [{ name: 'Dawn', passes: [{ layout: 'vertical', viewport: 'desktop', results: [{ id: 'V-10', layout: 'vertical', status: 'fail', detail: 'x', shots: [] }] }] }] };
  assert.strictEqual(buildSummary(run, checklist, null).date, '2026-11-19');
  assert.strictEqual(updateTracker(emptyTracker(), run, flatten(run), checklist).items['staging|Dawn|vertical|V-10'].firstSeen, '2026-11-19');
});

// ---------------- propagate
test('propagate: every step runs on its own and reports ok / failed', withEnv(async () => {
  const root = tmpRoot();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(url.split('/api/ingest/')[1]); return { ok: true }; };
  const ok = await propagate(root, CFG, { schedule: true, themes: true }, 'Dung', { applySchedule: () => ({ ok: true, message: 'task set' }), gitCommitPush: () => ({ ok: true, detail: 'pushed' }), fetchImpl });
  assert.deepStrictEqual(ok.map((s) => [s.step, s.ok]), [['Saved on the test machine', true], ['Windows Task Scheduler', true], ['Cloudflare', true], ['GitHub', true]]);
  assert.deepStrictEqual(calls, ['config', 'state'], 'the saved configuration and the dashboard data go to Cloudflare');
  const bad = await propagate(root, CFG, { schedule: true }, 'Dung', { applySchedule: () => ({ ok: false, error: 'access denied' }), gitCommitPush: () => { throw new Error('no network'); }, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.strictEqual(bad.find((s) => s.step === 'Windows Task Scheduler').ok, false);
  assert.match(bad.find((s) => s.step === 'Windows Task Scheduler').detail, /access denied/);
  assert.strictEqual(bad.find((s) => s.step === 'Cloudflare').ok, false);
  assert.strictEqual(bad.find((s) => s.step === 'GitHub').ok, false);
  assert.strictEqual(bad.length, 4, 'a failing step never hides the others');
  calls.length = 0;
  await propagate(root, CFG, { schedule: true }, 'the web page', { cloudConfig: false, applySchedule: () => ({ ok: true }), gitCommitPush: () => ({ ok: true }), fetchImpl });
  assert.deepStrictEqual(calls, ['state'], 'a change that CAME from Cloudflare is not sent back as a new configuration');
  const none = await propagate(root, { envs: {} }, { themes: true }, 'x', { gitCommitPush: () => ({ ok: true }) });
  assert.strictEqual(none.find((s) => s.step === 'Cloudflare').detail, 'not configured here, skipped');
}));

test('git step: commits only the two config files, as the automatic author, and pushes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-'));
  const remote = path.join(dir, 'remote.git'), work = path.join(dir, 'work');
  const g = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  fs.mkdirSync(remote);
  g(remote, 'init', '--bare', '-b', 'main');
  fs.mkdirSync(path.join(work, 'config'), { recursive: true });
  g(work, 'init', '-b', 'main');
  g(work, 'config', 'user.name', 'Someone');
  g(work, 'config', 'user.email', 'someone@example.com');
  fs.writeFileSync(path.join(work, 'config', 'schedule.json'), '{"a":1}');
  fs.writeFileSync(path.join(work, 'config', 'themes.json'), '{"themes":[]}');
  fs.writeFileSync(path.join(work, 'other.txt'), 'one');
  g(work, 'add', '-A'); g(work, 'commit', '-m', 'first');
  g(work, 'remote', 'add', 'origin', remote); g(work, 'push', '-u', 'origin', 'main');
  // changes: both config files and an unrelated file
  fs.writeFileSync(path.join(work, 'config', 'schedule.json'), '{"a":2}');
  fs.writeFileSync(path.join(work, 'other.txt'), 'two');
  const r = gitCommitPush(work, 'Config: schedule changed by Dung');
  assert.strictEqual(r.ok, true, r.detail);
  const last = g(work, 'log', '-1', '--format=%an|%ae|%s', '--name-only').stdout.trim().split('\n');
  assert.strictEqual(last[0], 'Theme Check|theme-check@users.noreply.github.com|Config: schedule changed by Dung');
  assert.deepStrictEqual(last.slice(1).filter(Boolean), ['config/schedule.json'], 'only the config file is in the commit');
  assert.match(g(work, 'status', '--short').stdout, / M other\.txt/, 'the unrelated change is left alone');
  assert.strictEqual(g(remote, 'log', '-1', '--format=%s').stdout.trim(), 'Config: schedule changed by Dung', 'it reached the remote');
  assert.match(gitCommitPush(work, 'again').detail, /nothing changed/);
  assert.strictEqual(gitCommitPush(dir, 'x').ok, false, 'a folder that is not a repository is reported, not crashed');
});

// ---------------- the agent
test('agent: applies a configuration saved on the web page, once, and reports back; bad ones are refused', withEnv(async () => {
  const root = tmpRoot();
  const sent = [];
  let remote = { rev: 0 };
  const fetchImpl = async (url, init) => {
    if (!init || !init.method || init.method === 'GET') return { ok: true, json: async () => remote };
    sent.push({ p: url.split('/api/ingest/')[1], body: JSON.parse(init.body) });
    return { ok: true };
  };
  const proped = [];
  const propagateFn = async (r, c, what, who, o) => { proped.push({ what, who, cloudConfig: o.cloudConfig }); return [{ step: 'Windows Task Scheduler', ok: true }, { step: 'GitHub', ok: true }]; };
  assert.deepStrictEqual(await agent.checkOnce(root, CFG, { fetchImpl, propagateFn }), { changed: false }, 'nothing saved yet');

  remote = { rev: 1000, updatedBy: 'dungnn@bsscommerce.com', schedule: { enabled: true, mode: 'everyNDays', everyDays: 3, time: '06:30', env: 'staging', batches: 'all', mail: true }, themes: [{ name: 'Dawn', envs: ['staging'], enabled: true }, { name: 'Craft', envs: ['staging', 'prod'], enabled: false }] };
  const r = await agent.checkOnce(root, CFG, { fetchImpl, propagateFn });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'config', 'schedule.json'), 'utf8')).everyDays, 3);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'config', 'themes.json'), 'utf8')).themes.map((t) => t.name), ['Dawn', 'Craft']);
  assert.deepStrictEqual(proped[0].what, { schedule: true, themes: true });
  assert.strictEqual(proped[0].who, 'dungnn@bsscommerce.com');
  assert.strictEqual(proped[0].cloudConfig, false);
  assert.strictEqual(sent[0].p, 'config-status');
  assert.strictEqual(sent[0].body.rev, 1000);
  assert.strictEqual(sent[0].body.ok, true);
  assert.strictEqual(agent.readRev(root), 1000);
  assert.deepStrictEqual(await agent.checkOnce(root, CFG, { fetchImpl, propagateFn }), { changed: false }, 'the same revision is never applied twice');

  // invalid values are refused on the machine too, and not retried every minute
  remote = { rev: 2000, schedule: { enabled: true, mode: 'hourly', time: '99:99', env: 'staging; calc', batches: 'all' } };
  const bad = await agent.checkOnce(root, CFG, { fetchImpl, propagateFn });
  assert.strictEqual(bad.changed, true);
  assert.ok(bad.error);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'config', 'schedule.json'), 'utf8')).everyDays, 3, 'the old schedule is kept');
  assert.strictEqual(sent[sent.length - 1].body.ok, false);
  assert.strictEqual(agent.readRev(root), 2000);
  assert.strictEqual(proped.length, 1);
  remote = { rev: 3000, themes: [{ name: '<b>x</b>' }] };
  assert.match((await agent.checkOnce(root, CFG, { fetchImpl, propagateFn })).error, /empty/);
}));

// ---------------- Cloudflare Functions: who may edit, and the hand-over to the machine
function fakeR2() {
  const m = new Map();
  return {
    m,
    async put(k, body, opts) { m.set(k, { buf: Buffer.from(typeof body === 'string' ? body : await new Response(body).arrayBuffer()), opts }); },
    async get(k) { const o = m.get(k); return o ? { body: o.buf, text: async () => o.buf.toString() } : null; },
    async delete(k) { m.delete(k); },
  };
}
const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

test('web editing: only listed editors can save; the test machine fetches it with its token and reports back', async () => {
  const lib = await imp('cf/lib.js');
  const env = { STORE: fakeR2(), SESSION_SECRET: 's'.repeat(40), ALLOWED_DOMAIN: 'bsscommerce.com', EDITORS: 'dungnn@bsscommerce.com', INGEST_TOKEN: 'ingest-token-1234567' };
  const cookieFor = async (email) => 'tc_session=' + (await lib.makeSession(env, { email, name: '' }));
  const config = await imp('functions/api/config.js');
  const status = await imp('functions/api/config-status.js');
  const me = await imp('functions/api/me.js');
  const ingest = await imp('functions/api/ingest/[[path]].js');
  const put = (cookie, body) => config.onRequestPut({ request: new Request('https://x.dev/api/config', { method: 'PUT', headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }), env });
  const sched = { enabled: true, mode: 'weekly', weekday: 'MON', everyDays: 7, time: '07:30', env: 'staging', batches: 'all', mail: true };

  assert.strictEqual((await put(null, { schedule: sched })).status, 403, 'not signed in');
  assert.strictEqual((await put(await cookieFor('other@bsscommerce.com'), { schedule: sched })).status, 403, 'a company account that is not an editor');
  assert.strictEqual((await put(await cookieFor('dungnn@gmail.com'), { schedule: sched })).status, 403, 'wrong domain');
  const ed = await cookieFor('dungnn@bsscommerce.com');
  assert.strictEqual((await put(ed, { schedule: { ...sched, mode: 'hourly' } })).status, 400);
  assert.strictEqual((await put(ed, { schedule: { ...sched, time: '25:00' } })).status, 400);
  assert.strictEqual((await put(ed, { schedule: { ...sched, env: 'x; del *' } })).status, 400);
  assert.strictEqual((await put(ed, { themes: [{ name: '<script>' }] })).status, 400);
  assert.strictEqual((await put(ed, {})).status, 400);
  assert.strictEqual(env.STORE.m.has('data/config.json'), false, 'nothing was stored by the refused calls');

  const okRes = await put(ed, { schedule: sched, themes: [{ name: 'Dawn', envs: ['staging'], enabled: true }] });
  assert.strictEqual(okRes.status, 200);
  const rev = (await okRes.json()).rev;
  const stored = JSON.parse(env.STORE.m.get('data/config.json').buf.toString());
  assert.strictEqual(stored.updatedBy, 'dungnn@bsscommerce.com');
  assert.strictEqual(stored.source, 'web');

  // who is an editor, as the page learns it
  const meOf = async (cookie) => (await me.onRequestGet({ request: new Request('https://x.dev/api/me', { headers: { cookie } }), env })).json();
  assert.strictEqual((await meOf(ed)).canEdit, true);
  assert.strictEqual((await meOf(await cookieFor('other@bsscommerce.com'))).canEdit, false);

  // the machine: needs its token, gets the configuration, reports what it did
  const ing = (method, p, body, auth) => ingest['onRequest' + method[0] + method.slice(1).toLowerCase()]({ request: new Request('https://x.dev/api/ingest/' + p, { method, headers: auth === false ? {} : { authorization: 'Bearer ' + env.INGEST_TOKEN }, body }), env, params: { path: [p] } });
  assert.strictEqual((await ing('GET', 'config', undefined, false)).status, 401);
  assert.strictEqual((await (await ing('GET', 'config')).json()).rev, rev);
  assert.strictEqual((await ing('POST', 'config-status', JSON.stringify({ rev, ok: true, at: new Date().toISOString(), steps: [{ step: 'GitHub', ok: true }] }))).status, 200);
  const seen = await (await status.onRequestGet({ request: new Request('https://x.dev/api/config-status', { headers: { cookie: ed } }), env })).json();
  assert.strictEqual(seen.status.ok, true);
  assert.strictEqual(seen.status.steps[0].step, 'GitHub');
  // a newer save clears the old status, so the page never shows a stale result
  await put(ed, { schedule: { ...sched, time: '08:00' } });
  assert.strictEqual((await (await status.onRequestGet({ request: new Request('https://x.dev/api/config-status', { headers: { cookie: ed } }), env })).json()).status, null);
  // a change made on the machine is sent up and validated there too
  assert.strictEqual((await ing('POST', 'config', JSON.stringify({ schedule: sched, themes: [{ name: 'Dawn' }], updatedBy: 'test machine' }))).status, 200);
  assert.strictEqual((await ing('POST', 'config', JSON.stringify({ schedule: { ...sched, mode: 'x' } }))).status, 400);
});

// ---------------- the page
test('the page: an editor saves from the web copy and sees what the machine did; others cannot edit', async () => {
  const http = require('http');
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const base = { readOnly: true, mediaLocal: true, envs: ['staging', 'prod'], themes: [{ name: 'Dawn', envs: ['staging'], batch: 1, enabled: true }], schedule: { enabled: true, mode: 'weekly', weekday: 'MON', everyDays: 7, time: '07:30', env: 'staging', batches: 'all', mail: true, description: 'Every week on MON at 07:30' }, runs: [], issues: { items: {} }, themeStatus: [], checklist: [], library: {} };
  const state = { canEdit: true, saved: null, applyAfter: 1, polls: 0 };
  const srv = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(200, base);
    if (req.url === '/api/progress') return send(200, { running: false, none: true });
    if (req.url === '/api/me') return send(200, { email: 'dungnn@bsscommerce.com', name: 'Dung', canEdit: state.canEdit });
    if (req.url === '/api/config' && req.method === 'PUT') { let b = ''; req.on('data', (d) => { b += d; }).on('end', () => { state.saved = JSON.parse(b); send(200, { ok: true, rev: 77 }); }); return; }
    if (req.url === '/api/config-status') { state.polls += 1; return send(200, { rev: 77, status: state.polls >= state.applyAfter ? { rev: 77, ok: true, at: '2026-11-18T07:25:46.000Z', steps: [{ step: 'Windows Task Scheduler', ok: true, detail: 'Every day at 06:30' }, { step: 'GitHub', ok: true, detail: 'committed and pushed to GitHub' }] } : null }); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const url = `http://127.0.0.1:${srv.address().port}/#schedule`;
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector('#s-save');
    await page.waitForFunction(() => !document.querySelector('#s-mode').disabled, null, { timeout: 8000 });
    assert.ok(await page.isVisible('#s-save'));
    assert.strictEqual(await page.locator('#s-apply').count(), 0, 'no Windows-only buttons on the web copy');
    assert.strictEqual(await page.locator('#r-go').count(), 0, 'no "Run now" on the web copy');
    assert.match(await page.textContent('main'), /UTC\+7/);
    await page.selectOption('#s-mode', 'daily');
    await page.fill('#s-time', '06:30');
    await page.click('#s-save');
    await page.waitForFunction(() => /Applied by the test machine at 2026-11-18 14:25:46 UTC\+7/.test(document.querySelector('#s-msg').textContent), null, { timeout: 15000 });
    assert.strictEqual(state.saved.schedule.mode, 'daily');
    assert.strictEqual(state.saved.schedule.time, '06:30');
    assert.strictEqual(state.saved.themes, undefined, 'only the schedule was sent');
    const steps = await page.textContent('#save-steps');
    assert.match(steps, /Windows Task Scheduler/);
    assert.match(steps, /GitHub: committed and pushed/);
    // themes
    await page.click('nav a[href="#themes"]');
    await page.waitForSelector('#t-new');
    await page.fill('#t-new', 'Brand New');
    await page.click('#t-add');
    await page.click('#t-save');
    await page.waitForFunction(() => /Applied by the test machine/.test(document.querySelector('#t-msg').textContent), null, { timeout: 15000 });
    assert.ok(state.saved.themes.some((t) => t.name === 'Brand New'));
    assert.strictEqual(state.saved.schedule, undefined);
    // a signed-in person who is not an editor can only look
    state.canEdit = false;
    const page2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page2.goto(url);
    await page2.waitForSelector('#s-save');
    await page2.waitForFunction(() => document.querySelector('#s-save').disabled === true, null, { timeout: 8000 });
    assert.match(await page2.textContent('main'), /can look at the schedule but not change it/);
    assert.deepStrictEqual(errors, []);
    await page.close(); await page2.close();
  } finally { await browser.close(); srv.close(); }
});

test('the live page shows event times in UTC+7', async () => {
  const http = require('http');
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const base = { readOnly: true, mediaLocal: true, envs: ['staging'], themes: [], schedule: { description: 'x' }, runs: [], issues: { items: {} }, themeStatus: [], checklist: [], library: {} };
  const prog = { running: true, runId: 'r', env: 'staging', startedAt: '2026-11-18T07:25:46.000Z', updatedAt: new Date().toISOString(), phase: 'testing', mode: 'background', themes: [{ name: 'Dawn', batch: 1, status: 'testing', step: 'x', fail: 0, pass: 0, startedAt: '2026-11-18T07:26:00.000Z' }], events: [{ t: '2026-11-18T07:25:46.000Z', msg: 'Testing Horizon' }], totals: { pass: 0, fail: 0, na: 0, review: 0 } };
  const srv = http.createServer((req, res) => {
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(base);
    if (req.url === '/api/progress') return send(prog);
    if (req.url === '/api/me') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/#live`);
    await page.waitForFunction(() => /Live progress/.test(document.querySelector('main').textContent));
    const txt = await page.textContent('main');
    assert.match(txt, /started 2026-11-18 14:25 \(UTC\+7\)/);
    assert.match(txt, /14:25:46\s*Testing Horizon/);
    assert.match(txt, /Recent events \(UTC\+7\)/);
    await page.close();
  } finally { await browser.close(); srv.close(); }
});
