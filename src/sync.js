// Runner side of the Cloudflare monitor: push live progress while a run is going, and the finished run's data and files afterwards.
// Config (config.local.json):  "cloudflare": { "url": "https://theme-check.pages.dev", "uploadVideos": false }
// Secrets come from the environment, never from a file:  THEME_CHECK_TOKEN  (the INGEST_TOKEN set on Cloudflare),
// and, if Cloudflare Access protects the site,  CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  (a service token).
const fs = require('fs');
const path = require('path');
const { runsDir } = require('./store/paths');

function syncConfig(cfg, env) {
  const c = cfg && cfg.cloudflare;
  const e = env || process.env;
  if (!c || !c.url || /FILL-ME|example\.com/i.test(c.url)) return null;
  const token = e.THEME_CHECK_TOKEN;
  if (!token) return { error: 'THEME_CHECK_TOKEN is not set, so nothing is pushed to Cloudflare.' };
  const headers = { Authorization: `Bearer ${token}` };
  if (e.CF_ACCESS_CLIENT_ID && e.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = e.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = e.CF_ACCESS_CLIENT_SECRET;
  }
  return { base: c.url.replace(/\/$/, ''), headers, uploadVideos: !!c.uploadVideos };
}

async function send(sync, method, p, body, contentType, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`${sync.base}/api/ingest/${p}`, { method, headers: Object.assign({ 'Content-Type': contentType || 'application/json' }, sync.headers), body });
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status}`);
  return res;
}

// Calls onChange(progress) from Progress; sends at most one update every `everyMs`, and always sends the last one.
function createProgressPusher(sync, opts) {
  const o = Object.assign({ everyMs: 8000, fetchImpl: null, onError: (m) => console.log(m) }, opts);
  let last = 0, timer = null, pending = null, warned = false, inflight = Promise.resolve();
  const flush = () => {
    timer = null;
    const body = JSON.stringify(pending);
    last = Date.now();
    inflight = inflight.then(() => send(sync, 'POST', 'progress', body, null, o.fetchImpl)).catch((e) => { if (!warned) { warned = true; o.onError(`Monitor push failed (${e.message}); the run continues.`); } });
  };
  const push = (s) => {
    pending = s;
    const due = Date.now() - last >= o.everyMs;
    if (!s.running || due) { if (timer) { clearTimeout(timer); } flush(); }
    else if (!timer) timer = setTimeout(flush, o.everyMs - (Date.now() - last));
  };
  push.done = () => inflight;
  return push;
}

function walk(dir, out) {
  (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  });
  return out;
}

// Upload one run's files (report, summary, results, pictures, and videos only if asked) with a small pool.
async function pushRunFiles(sync, runDir, runId, opts) {
  const o = Object.assign({ concurrency: 4, fetchImpl: null }, opts);
  const files = walk(runDir, []).filter((f) => !/_video|_debug|\.tmp$/.test(f) && (sync.uploadVideos || !/\.webm$/i.test(f)));
  let i = 0, ok = 0; const failed = [];
  async function worker() {
    while (i < files.length) {
      const f = files[i++];
      const rel = path.relative(runDir, f).split(path.sep).join('/');
      try {
        const buf = fs.readFileSync(f);
        if (buf.length > 90e6) { failed.push(`${rel}: over 90 MB, skipped`); continue; }
        await send(sync, 'PUT', `media/${runId}/${rel}`, buf, 'application/octet-stream', o.fetchImpl);
        ok++;
      } catch (e) { failed.push(`${rel}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  return { uploaded: ok, failed };
}

async function pushState(sync, state, fetchImpl) {
  await send(sync, 'POST', 'state', JSON.stringify(state), null, fetchImpl);
}

module.exports = { syncConfig, send, createProgressPusher, pushRunFiles, pushState, runsDir };
