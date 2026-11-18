// Glue between a run and the Cloudflare monitor. Everything here is optional: no "cloudflare" config means no pushing.
const fs = require('fs');
const path = require('path');
const sync = require('./sync');
const { buildState } = require('./publish');
const { runsDir } = require('./store/paths');

function forRun(root, cfg) {
  const s = sync.syncConfig(cfg);
  if (!s) return { onProgress: null, onFinish: null };
  if (s.error) { console.log(`Monitor: ${s.error}`); return { onProgress: null, onFinish: null }; }
  console.log(`Monitor: pushing live progress to ${s.base}`);
  const pusher = sync.createProgressPusher(s);
  return {
    onProgress: pusher,
    onFinish: async ({ run, runDir }) => {
      await pusher.done();
      await sync.pushState(s, buildState(root, cfg));
      const r = await sync.pushRunFiles(s, runDir, run.runId);
      console.log(`Monitor: pushed dashboard data and ${r.uploaded} file(s)${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0]})` : ''}`);
    },
  };
}

// node src/cli.js sync [--run <id>] [--all]: send the dashboard data now, plus the files of one run or of every run.
async function syncNow(root, cfg, opts) {
  const s = sync.syncConfig(cfg);
  if (!s) return { ok: false, message: 'No "cloudflare" section in config/config.local.json (needs "url").' };
  if (s.error) return { ok: false, message: s.error };
  try { await sync.send(s, 'POST', 'ping', '{}'); } catch (e) { return { ok: false, message: `Cannot reach the monitor: ${e.message}. Check the url, THEME_CHECK_TOKEN, and the Access service token.` }; }
  await sync.pushState(s, buildState(root, cfg));
  const dir = runsDir(root, cfg);
  const ids = opts.all ? (fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'report.html'))) : []) : (opts.run ? [opts.run] : []);
  let up = 0, bad = 0;
  for (const id of ids) {
    const r = await sync.pushRunFiles(s, path.join(dir, id), id);
    up += r.uploaded; bad += r.failed.length;
  }
  return { ok: true, message: `Monitor updated: dashboard data${ids.length ? `, ${ids.length} run(s), ${up} file(s)${bad ? `, ${bad} failed` : ''}` : ''}.` };
}

module.exports = { forRun, syncNow };
