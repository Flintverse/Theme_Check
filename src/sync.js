// Runner side of the Cloudflare monitor: push live progress while a run is going, and the dashboard data afterwards.
// Config (config.local.json):  "cloudflare": { "url": "https://theme-check.pages.dev", "progressEverySeconds": 90 }
// Secret from the environment, never from a file:  THEME_CHECK_TOKEN  (the INGEST_TOKEN set on Cloudflare).
// Only small JSON goes to Cloudflare (KV). Pictures, videos and reports stay on this machine / Google Drive.
// Free KV allows about 1,000 writes a day, so progress is sent at most every 90 s and at most 900 times a day.
const FEW = 900;

function syncConfig(cfg, env) {
  const c = cfg && cfg.cloudflare;
  const e = env || process.env;
  if (!c || !c.url || /FILL-ME|example\.com/i.test(c.url)) return null;
  const token = e.THEME_CHECK_TOKEN;
  if (!token) return { error: 'THEME_CHECK_TOKEN is not set, so nothing is pushed to Cloudflare.' };
  const headers = { Authorization: `Bearer ${token}` };
  if (e.CF_ACCESS_CLIENT_ID && e.CF_ACCESS_CLIENT_SECRET) { // only if Cloudflare Access also protects the site
    headers['CF-Access-Client-Id'] = e.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = e.CF_ACCESS_CLIENT_SECRET;
  }
  return { base: c.url.replace(/\/$/, ''), headers, everyMs: Math.max(30, Number(c.progressEverySeconds) || 90) * 1000 };
}

async function send(sync, method, p, body, contentType, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`${sync.base}/api/ingest/${p}`, { method, headers: Object.assign({ 'Content-Type': contentType || 'application/json' }, sync.headers), body });
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status}`);
  return res;
}

// Calls onChange(progress) from Progress. Sends at most one update every `everyMs`, at most FEW a day, and always
// sends the final one (run finished). A failing monitor never breaks the run.
function createProgressPusher(sync, opts) {
  const o = Object.assign({ everyMs: (sync && sync.everyMs) || 90000, fetchImpl: null, onError: (m) => console.log(m), maxPerDay: FEW, now: () => Date.now() }, opts);
  let last = 0, timer = null, pending = null, warned = false, inflight = Promise.resolve(), day = '', count = 0;
  const flush = () => {
    timer = null;
    const today = new Date(o.now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; count = 0; }
    if (pending.running && count >= o.maxPerDay) return; // daily budget used up: only the final update still goes out
    count++;
    const body = JSON.stringify(pending);
    last = o.now();
    inflight = inflight.then(() => send(sync, 'POST', 'progress', body, null, o.fetchImpl)).catch((e) => { if (!warned) { warned = true; o.onError(`Monitor push failed (${e.message}); the run continues.`); } });
  };
  const push = (s) => {
    pending = s;
    const due = o.now() - last >= o.everyMs;
    if (!s.running || due) { if (timer) clearTimeout(timer); flush(); }
    else if (!timer) timer = setTimeout(flush, Math.max(0, o.everyMs - (o.now() - last)));
  };
  push.done = () => inflight;
  return push;
}

async function pushState(sync, state, fetchImpl) {
  await send(sync, 'POST', 'state', JSON.stringify(state), null, fetchImpl);
}

module.exports = { syncConfig, send, createProgressPusher, pushState };
