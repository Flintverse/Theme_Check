// Glue between a run and the Cloudflare monitor. Everything here is optional: no "cloudflare" config means no pushing.
const fs = require('fs');
const path = require('path');
const sync = require('./sync');
const { buildState } = require('./publish');
const { runsDir, dataDir } = require('./store/paths');
const { withEta } = require('./store/progress');

const remoteState = (root, cfg) => buildState(root, cfg, { remote: true });

// While a run goes on, keeps the results of the themes already tested (and their pictures) on Cloudflare, so the Live
// page can open a theme without waiting for the whole run. Only changed files go up; at most once per `minMs`.
function liveRunPusher(s, root, cfg, minMs) {
  const seen = new Map();
  let last = 0, busy = false;
  return async function push(p, force) {
    if (!p || !p.runId || busy || (!force && Date.now() - last < (minMs || 45000))) return null;
    busy = true;
    try {
      const runDir = path.join(runsDir(root, cfg), p.runId);
      const files = sync.liveRunFiles(runDir);
      last = Date.now();
      if (!files) return null;
      return await sync.pushRunFiles(s, runDir, p.runId, { files, seen });
    } catch (e) { return null; } finally { busy = false; }
  };
}

function forRun(root, cfg) {
  const s = sync.syncConfig(cfg);
  if (!s) return { onProgress: null, onFinish: null };
  if (s.error) { console.log(`Monitor: ${s.error}`); return { onProgress: null, onFinish: null }; }
  console.log(`Monitor: pushing live progress to ${s.base} (about every ${Math.round(s.everyMs / 1000)} s)`);
  const pusher = sync.createProgressPusher(s);
  const livePush = liveRunPusher(s, root, cfg);
  return {
    onProgress: (p) => { pusher(withEta(Object.assign({}, p))); livePush(p); }, // counts and the estimate travel with the progress
    onFinish: async ({ run, runDir }) => {
      await pusher.done();
      await sync.pushState(s, remoteState(root, cfg));
      const r = await sync.pushRunFiles(s, runDir, run.runId);
      console.log(`Monitor: pushed the dashboard data and ${r.uploaded} file(s)${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0]})` : ''}`);
    },
  };
}

// node src/cli.js sync [--run <id>] [--all]: send the dashboard data now, plus the files of one run or of every run.
async function syncNow(root, cfg, opts) {
  const s = sync.syncConfig(cfg);
  if (!s) return { ok: false, message: 'No "cloudflare" section in config/config.local.json (needs "url").' };
  if (s.error) return { ok: false, message: s.error };
  try { await sync.send(s, 'POST', 'ping', '{}'); } catch (e) { return { ok: false, message: `Cannot reach the monitor: ${e.message}. Check the url and THEME_CHECK_TOKEN.` }; }
  await sync.pushState(s, remoteState(root, cfg));
  const dir = runsDir(root, cfg);
  const ids = opts && opts.all ? (fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'report.html'))) : []) : (opts && opts.run ? [opts.run] : []);
  let up = 0, bad = 0;
  for (const id of ids) { const r = await sync.pushRunFiles(s, path.join(dir, id), id); up += r.uploaded; bad += r.failed.length; }
  return { ok: true, message: `Monitor updated: dashboard data${ids.length ? `, ${ids.length} run(s), ${up} file(s)${bad ? `, ${bad} failed` : ''}` : ''}.` };
}

// node src/cli.js watch: push the local progress file while it changes, and the data when a run ends.
async function watch(root, cfg, opts) {
  const { readProgress } = require('./store/progress');
  const s = sync.syncConfig(cfg);
  if (!s || s.error) { console.log((s && s.error) || 'No "cloudflare" section in config/config.local.json.'); return; }
  const pusher = sync.createProgressPusher(s);
  const livePush = liveRunPusher(s, root, cfg);
  let wasRunning = null;
  await sync.pushState(s, remoteState(root, cfg)).catch((e) => console.log('state push failed: ' + e.message));
  console.log('Watching the run progress and pushing it to ' + s.base + ' (Ctrl+C to stop)');
  const tick = async () => {
    if (opts && opts.extraTick) await opts.extraTick();
    const p = readProgress(dataDir(root, cfg));
    if (!p) return;
    pusher(p);
    if (p.running) await livePush(p);
    if (wasRunning && !p.running) { await livePush(p, true); await pusher.done(); await sync.pushState(s, remoteState(root, cfg)).catch((e) => console.log('state push failed: ' + e.message)); console.log('Run ended: dashboard data pushed.'); }
    wasRunning = p.running;
  };
  await tick();
  await new Promise((resolve) => { const t = setInterval(tick, (opts && opts.everyMs) || 15000); process.on('SIGINT', () => { clearInterval(t); resolve(); }); });
}

module.exports = { forRun, syncNow, watch };
