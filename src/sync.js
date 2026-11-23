// Runner side of the Cloudflare monitor (R2): push live progress while a run is going, and the finished run's data,
// report and pictures afterwards.   Config (config.local.json):  "cloudflare": { "url": "https://theme-check.pages.dev" }
// Secret from the environment, never from a file:  THEME_CHECK_TOKEN  (the INGEST_TOKEN set on Cloudflare).
// If Cloudflare Access also protects the site: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (a service token).
const fs = require('fs');
const path = require('path');

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
  return { base: c.url.replace(/\/$/, ''), headers, everyMs: Math.max(10, Number(c.progressEverySeconds) || 30) * 1000 };
}

async function send(sync, method, p, body, contentType, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`${sync.base}/api/ingest/${p}`, { method, headers: Object.assign({ 'Content-Type': contentType || 'application/json' }, sync.headers), body });
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status}`);
  return res;
}

// Calls onChange(progress) from Progress. Sends at most one update every `everyMs` and always sends the last one.
// A failing monitor never breaks the run.
function createProgressPusher(sync, opts) {
  const o = Object.assign({ everyMs: (sync && sync.everyMs) || 30000, fetchImpl: null, onError: (m) => console.log(m), now: () => Date.now() }, opts);
  let last = 0, timer = null, pending = null, warned = false, inflight = Promise.resolve(), lastCount = 0, lastPhase = '';
  const flush = () => {
    timer = null;
    const body = JSON.stringify(pending);
    const where = 'progress' + (pending && /^[\w-]{1,20}$/.test(pending.env || '') ? '/' + pending.env : ''); // one file per store, so two runs do not overwrite each other
    last = o.now();
    inflight = inflight.then(() => send(sync, 'POST', where, body, null, o.fetchImpl)).catch((e) => { if (!warned) { warned = true; o.onError(`Monitor push failed (${e.message}); the run continues.`); } });
  };
  const push = (s) => {
    pending = s;
    // the first real state (theme list), and every change of phase, goes out at once; the rest is throttled
    const count = (s.themes || []).length;
    const changed = (count && !lastCount) || (s.phase && s.phase !== lastPhase);
    lastCount = count; lastPhase = s.phase || '';
    const due = changed || o.now() - last >= o.everyMs;
    if (!s.running || due) { if (timer) clearTimeout(timer); flush(); }
    else if (!timer) timer = setTimeout(flush, Math.max(0, o.everyMs - (o.now() - last)));
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

// Upload one run's report, summary, results and pictures (never videos) with a small pool.
async function pushRunFiles(sync, runDir, runId, opts) {
  // opts.files: only these files; opts.seen: a Map remembering what was already uploaded, so only new or changed files go up
  const o = Object.assign({ concurrency: 4, fetchImpl: null, files: null, seen: null }, opts);
  const files = o.files || walk(runDir, []).filter((f) => /\.(png|html|json)$/i.test(f) && !/_debug|_video/.test(f));
  let i = 0, ok = 0; const failed = [];
  async function worker() {
    while (i < files.length) {
      const f = files[i++];
      const rel = path.relative(runDir, f).split(path.sep).join('/');
      try {
        const st = fs.statSync(f);
        const sig = st.mtimeMs + ':' + st.size;
        if (o.seen && o.seen.get(rel) === sig) continue;
        const buf = fs.readFileSync(f);
        if (buf.length > 15e6) { failed.push(`${rel}: over 15 MB, skipped`); continue; }
        await send(sync, 'PUT', `media/${runId}/${rel}`, buf, 'application/octet-stream', o.fetchImpl);
        if (o.seen) o.seen.set(rel, sig);
        ok++;
      } catch (e) { failed.push(`${rel}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  return { uploaded: ok, failed };
}

// The files of a run that is still going: results.json, report.html and only the pictures of failing / review checks
// (the same ones that are kept when the run ends). null when results.json is missing or half written.
function liveRunFiles(runDir) {
  let run;
  try { run = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8')); } catch (e) { return null; }
  const files = [path.join(runDir, 'results.json'), path.join(runDir, 'report.html')]; // (the sender redraws the reports itself)
  (run.themes || []).forEach((t) => (t.passes || []).forEach((p) => (p.results || []).forEach((r) => {
    if (/^(fail|error|review)$/.test(r.status)) (r.shots || []).forEach((s) => files.push(path.join(runDir, s)));
  })));
  return files.filter((f) => fs.existsSync(f));
}

async function pushState(sync, state, fetchImpl) {
  await send(sync, 'POST', 'state', JSON.stringify(state), null, fetchImpl);
}

module.exports = { syncConfig, send, createProgressPusher, pushRunFiles, liveRunFiles, pushState };
