// Glue between a run and the Cloudflare monitor. Everything here is optional: no "cloudflare" config means no pushing.
const sync = require('./sync');
const { buildState } = require('./publish');

function forRun(root, cfg) {
  const s = sync.syncConfig(cfg);
  if (!s) return { onProgress: null, onFinish: null };
  if (s.error) { console.log(`Monitor: ${s.error}`); return { onProgress: null, onFinish: null }; }
  console.log(`Monitor: pushing live progress to ${s.base} (about every ${Math.round(s.everyMs / 1000)} s)`);
  const pusher = sync.createProgressPusher(s);
  return {
    onProgress: pusher,
    onFinish: async () => {
      await pusher.done();
      await sync.pushState(s, buildState(root, cfg));
      console.log('Monitor: pushed the dashboard data (runs, issue tracker, themes).');
    },
  };
}

// node src/cli.js sync: send the dashboard data now.
async function syncNow(root, cfg) {
  const s = sync.syncConfig(cfg);
  if (!s) return { ok: false, message: 'No "cloudflare" section in config/config.local.json (needs "url").' };
  if (s.error) return { ok: false, message: s.error };
  try { await sync.send(s, 'POST', 'ping', '{}'); } catch (e) { return { ok: false, message: `Cannot reach the monitor: ${e.message}. Check the url and THEME_CHECK_TOKEN.` }; }
  await sync.pushState(s, buildState(root, cfg));
  return { ok: true, message: 'Monitor updated: dashboard data (runs, issue tracker, themes).' };
}

// node src/cli.js watch: push the local progress file to Cloudflare while it changes, and the dashboard data when a run
// ends. For runs that were started without the monitor configured, and as a safety net for any run.
async function watch(root, cfg, opts) {
  const { readProgress } = require('./store/progress');
  const { dataDir } = require('./store/paths');
  const s = sync.syncConfig(cfg);
  if (!s || s.error) { console.log((s && s.error) || 'No "cloudflare" section in config/config.local.json.'); return; }
  const pusher = sync.createProgressPusher(s);
  let wasRunning = null;
  await sync.pushState(s, buildState(root, cfg)).catch((e) => console.log('state push failed: ' + e.message));
  console.log('Watching the run progress and pushing it to ' + s.base + ' (Ctrl+C to stop)');
  const tick = async () => {
    const p = readProgress(dataDir(root, cfg));
    if (!p) return;
    pusher(p);
    if (wasRunning && !p.running) { await pusher.done(); await sync.pushState(s, buildState(root, cfg)).catch((e) => console.log('state push failed: ' + e.message)); console.log('Run ended: dashboard data pushed.'); }
    wasRunning = p.running;
  };
  await tick();
  await new Promise((resolve) => { const t = setInterval(tick, (opts && opts.everyMs) || 30000); process.on('SIGINT', () => { clearInterval(t); resolve(); }); });
}

module.exports = { forRun, syncNow, watch };
