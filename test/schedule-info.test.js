// The Schedule page: what is registered, what runs now, what is next, and turning it off.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const sched = require('../src/schedule');
const agent = require('../src/agent');

const SRC = path.resolve(__dirname, '..');
const tmpRoot = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-si-'));
  fs.mkdirSync(path.join(r, 'config'), { recursive: true });
  return r;
};
const CFG = { envs: { staging: {}, prod: {} }, cloudflare: { url: 'https://x.dev' } };

test('task times: US and day-first formats become "YYYY-MM-DD HH:MM"; Windows\' "never ran" date and N/A become nothing', () => {
  assert.strictEqual(sched.parseTaskTime('11/26/2026 9:00:00 AM'), '2026-11-26 09:00');
  assert.strictEqual(sched.parseTaskTime('11/26/2026 9:05:00 PM'), '2026-11-26 21:05');
  assert.strictEqual(sched.parseTaskTime('12/01/2026 12:30:00 AM'), '2026-12-01 00:30');
  assert.strictEqual(sched.parseTaskTime('26/11/2026 21:05:00'), '2026-11-26 21:05');
  assert.strictEqual(sched.parseTaskTime('11/30/1999 12:00:00 AM'), null);
  assert.strictEqual(sched.parseTaskTime('N/A'), null);
  assert.strictEqual(sched.parseTaskTime(undefined), null);
});

test('schedule info: saved settings against the registered task; drift is named; running and queued are listed', () => {
  const root = tmpRoot();
  sched.saveSchedule(root, Object.assign({}, sched.DEFAULT, { enabled: true, mode: 'everyNDays', everyDays: 3, time: '09:00', env: 'prod', batches: 'all', mail: true }));
  const progress = [{ env: 'staging', runId: '2026-11-23-staging', running: true, startedAt: '2026-11-23T02:00:00Z', counts: { done: 23, total: 58 }, current: { theme: 'Trade', step: 'Testing' } }, { env: 'prod', runId: 'old', running: false }];
  const queue = [{ id: 'a', status: 'queued', env: 'staging', themes: ['Dawn', 'Craft'], requestedBy: 'x@y.com', requestedAt: '2026-11-23T03:00:00Z' }, { id: 'b', status: 'done', env: 'prod', themes: [] }];
  // the task is registered and starts the launcher file: it runs STAGING while the saved settings say prod
  sched.writeLauncher({ env: 'staging', batches: 'all', mail: true }, root);
  const registered = () => ({ registered: true, status: 'Ready', nextRun: '11/26/2026 9:00:00 AM', lastRun: '11/23/2026 9:00:02 AM', lastResult: '0' });
  const a = sched.info(root, CFG, { queryFn: registered, progress, queue });
  assert.strictEqual(a.task.nextRun, '2026-11-26 09:00');
  assert.strictEqual(a.task.lastRun, '2026-11-23 09:00');
  assert.deepStrictEqual(a.task.runs, { env: 'staging', batches: 'all', mail: true });
  assert.strictEqual(a.inSync, false);
  assert.match(a.drift[0], /registered task does not match.*store staging \(saved: prod\)/);
  assert.deepStrictEqual(a.running.map((r) => [r.env, r.done, r.total, r.current]), [['staging', 23, 58, 'Trade - Testing']]);
  assert.deepStrictEqual(a.queued.map((r) => [r.id, r.themes]), [['a', 2]]);
  // on and nothing registered: it says so
  const b = sched.info(root, CFG, { queryFn: () => ({ registered: false }), progress: [], queue: [] });
  assert.match(b.drift[0], /saved as On, but no Windows task is registered/);
  // off and nothing registered: all quiet. Off but a task is still there: it says so.
  sched.saveSchedule(root, Object.assign({}, sched.DEFAULT, { enabled: false }));
  assert.strictEqual(sched.info(root, CFG, { queryFn: () => ({ registered: false }), progress: [], queue: [] }).inSync, true);
  assert.match(sched.info(root, CFG, { queryFn: registered, progress: [], queue: [] }).drift[0], /saved as Off, but a Windows task is still registered \(next run 2026-11-26 09:00\)/);
});

test('agent: the schedule info goes up when it changes and at least every 90 seconds, not on every look', async () => {
  const root = tmpRoot();
  const old = process.env.THEME_CHECK_TOKEN; process.env.THEME_CHECK_TOKEN = 'tok-tok-tok-tok-1234';
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  let n = 0;
  const infoFn = () => ({ at: new Date().toISOString(), saved: { enabled: false }, task: { registered: false }, running: n ? [{ env: 'staging', done: n }] : [], queued: [], drift: [], inSync: true });
  try {
    assert.strictEqual((await agent.syncScheduleInfo(root, CFG, { fetchImpl, infoFn, force: true })).sent, true);
    assert.strictEqual((await agent.syncScheduleInfo(root, CFG, { fetchImpl, infoFn })).sent, false, 'nothing changed: not sent again');
    n = 5;
    assert.strictEqual((await agent.syncScheduleInfo(root, CFG, { fetchImpl, infoFn })).sent, true, 'a run started: sent');
    assert.strictEqual(sent.length, 2);
  } finally { if (old === undefined) delete process.env.THEME_CHECK_TOKEN; else process.env.THEME_CHECK_TOKEN = old; }
});

test('Cloudflare: the page can read the schedule info; it says whether the test machine was seen lately', async () => {
  const store = new Map();
  const R2 = { async get(k) { return store.has(k) ? { text: async () => store.get(k) } : null; } };
  const env = { STORE: R2, SESSION_SECRET: 's'.repeat(40), ALLOWED_DOMAIN: 'bsscommerce.com', INGEST_TOKEN: 'ingest-token-1234567' };
  const lib = await import(pathToFileURL(path.join(SRC, 'cf/lib.js')).href);
  const fn = await import(pathToFileURL(path.join(SRC, 'functions/api/schedule-info.js')).href);
  const req = async (signed) => new Request('https://x.dev/api/schedule-info', { headers: signed ? { cookie: 'tc_session=' + (await lib.makeSession(env, { email: 'a@bsscommerce.com', name: 'a' })) } : {} });
  assert.strictEqual((await fn.onRequestGet({ request: await req(false), env })).status, 401);
  assert.strictEqual((await (await fn.onRequestGet({ request: await req(true), env })).json()).none, true);
  store.set('data/schedule-info.json', JSON.stringify({ at: new Date().toISOString(), saved: { enabled: true } }));
  assert.strictEqual((await (await fn.onRequestGet({ request: await req(true), env })).json()).machineSeen, true);
  store.set('data/schedule-info.json', JSON.stringify({ at: new Date(Date.now() - 10 * 60000).toISOString(), saved: { enabled: true } }));
  const old = await (await fn.onRequestGet({ request: await req(true), env })).json();
  assert.strictEqual(old.machineSeen, false);
  assert.ok(old.ageSeconds >= 600);
});

test('the page: the Schedule tab shows what is on, registered, next, last and running; names a mismatch; Turn off saves the schedule as Off', async () => {
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'index.html'));
  const schedule = { enabled: true, mode: 'everyNDays', weekday: 'MON', everyDays: 3, time: '09:00', env: 'prod', batches: 'all', mail: true, description: 'Every 3 days at 09:00' };
  const base = { readOnly: true, mediaLocal: true, envs: ['staging', 'prod'], themes: [], schedule, task: null, runs: [], issues: { items: {} }, themeStatus: [], checklist: [], library: {} };
  const in3d = new Date(Date.now() + 3 * 86400000 + 5 * 3600000 + 7 * 3600000); // shown in UTC+7: add 7 h to read it back as that clock time
  const pad = (n) => String(n).padStart(2, '0');
  const next = `${in3d.getUTCFullYear()}-${pad(in3d.getUTCMonth() + 1)}-${pad(in3d.getUTCDate())} ${pad(in3d.getUTCHours())}:00`;
  const info = { at: new Date().toISOString(), machineSeen: true, ageSeconds: 5, saved: schedule, task: { registered: true, status: 'Ready', nextRun: next, lastRun: '2026-11-23 09:00', lastResult: '0', runs: { env: 'staging', batches: 'all', mail: true } },
    inSync: false, drift: ['The registered task does not match the saved settings: it runs store staging (saved: prod). Press Save schedule to apply the saved settings.'],
    running: [{ env: 'staging', runId: 'r1', startedAt: '2026-11-23T02:00:00Z', done: 23, total: 58, current: 'Trade - Testing' }], queued: [{ id: 'q', env: 'staging', themes: 2, requestedBy: 'x@y.com', requestedAt: '2026-11-23T03:00:00Z' }] };
  const st = { saved: null };
  const srv = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return send(200, base);
    if (req.url === '/api/progress') return send(200, { running: false, none: true });
    if (req.url === '/api/schedule-info') return send(200, info);
    if (req.url === '/api/me') return send(200, { email: 'dungnn@bsscommerce.com', name: 'Dung', canEdit: true });
    if (req.url === '/api/config' && req.method === 'PUT') { let b = ''; req.on('data', (d) => { b += d; }).on('end', () => { st.saved = JSON.parse(b); send(200, { ok: true, rev: 5 }); }); return; }
    if (req.url === '/api/config-status') return send(200, { rev: 5, status: { rev: 5, ok: true, at: '2026-11-23T07:00:00Z', steps: [{ step: 'Windows Task Scheduler', ok: true, detail: 'Task removed' }] } });
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(ui);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${srv.address().port}/#schedule`);
    await page.waitForSelector('[data-si="off"]');
    const box = await page.textContent('#si-box');
    assert.match(box, /Automatic runs\s*ON/);
    assert.match(box, /Windows task\s*Registered/);
    assert.match(box, /Next run/);
    assert.match(box, new RegExp(next.slice(5)), 'the next run time is shown');
    assert.match(box, /in 3d/, 'and how long until it');
    assert.match(box, /Last run\s*11-23 09:00\s*ended OK/);
    assert.match(box, /does not match the saved settings: it runs store staging \(saved: prod\)/);
    assert.match(box, /Running now[\s\S]*staging[\s\S]*23 of 58 themes[\s\S]*Trade - Testing/);
    assert.match(box, /Waiting: 2 theme\(s\) for staging, asked by x@y.com/);
    assert.ok(await page.locator('#si-box a[data-live-env="staging"]').count(), 'Watch it live');
    // Edit scrolls to the form
    await page.click('[data-si="edit"]');
    assert.ok(await page.isVisible('#sched-form'));
    // Turn off: the schedule is saved as Off with its settings kept (the test machine then removes the Windows task)
    await page.click('[data-si="off"]');
    await page.waitForFunction(() => /Applied/.test(document.querySelector('#si-msg').textContent));
    assert.strictEqual(st.saved.schedule.enabled, false);
    assert.strictEqual(st.saved.schedule.time, '09:00');
    assert.strictEqual(st.saved.schedule.env, 'prod');
    assert.strictEqual(st.saved.schedule.description, undefined, 'only the settings are sent');
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
