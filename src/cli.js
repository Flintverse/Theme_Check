#!/usr/bin/env node
/*
 * node src/cli.js login  --env staging|prod            one-time Shopify admin login (saved in .profile-<env>/, no password stored)
 * node src/cli.js run    --env staging [--batches 1,2] [--themes "Dawn,Craft"] [--skip-clean] [--skip-wait] [--mail] [--dry-mail]
 *                                                     the weekly loop (docs/WORKFLOW.md): clean, install batch, test, report
 * node src/cli.js check  --url <storefront url> [--name dawn] [--layouts vertical,horizontal,offcanvas,mobile,search]
 *                                                     no admin: run the checklist on one storefront URL
 * node src/cli.js report --run 2026-11-18-staging      rebuild report.html from results.json
 * node src/cli.js mail   --run 2026-11-18-staging [--dry]  send (or print) the Gmail summary
 * node src/cli.js library --env staging              read the store's theme library and compare it with the theme list
 * node src/cli.js agent [--install|--uninstall]      the hidden helper: applies changes saved on the web page, keeps the live progress on the page
 * node src/cli.js watch                               keep pushing the live progress to Cloudflare (for a run started without the monitor)
 * node src/cli.js sync   [--run <id>] [--all]         push the dashboard data (and a run's report and pictures) to Cloudflare
 * node src/cli.js ui     [--port 4173]                 local dashboard: themes, schedule, run now, history, issue tracker
 * node src/cli.js publish [--out site] [--dashboard-only]   read-only copy of the dashboard for a static host
 */
const fs = require('fs');
const path = require('path');
const { loginFlow, profileDirFor } = require('./lib/browser');
const { render } = require('./report/html');
const { findPrevious } = require('./report/compare');
const { buildMail, sendMail, attachmentsFor } = require('./mail');

const { runsDir, dataDir } = require('./store/paths');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { a._.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n && !n.startsWith('--')) { a[k] = n; i++; } else a[k] = true;
  }
  return a;
}

function loadConfig() {
  const local = path.join(ROOT, 'config', 'config.local.json');
  const file = fs.existsSync(local) ? local : path.join(ROOT, 'config', 'config.example.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg._file = path.basename(file);
  return cfg;
}
const loadChecklist = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'checklist', 'checklist.json'), 'utf8'));
const loadThemes = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'themes.json'), 'utf8')).themes;

function readRun(runId, cfg) {
  const dir = path.join(runsDir(ROOT, cfg), runId);
  return { dir, run: JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) };
}

async function doMail(cfg, runId, dry) {
  const { dir, run } = readRun(runId, cfg);
  const prev = findPrevious(runsDir(ROOT, cfg), run.env, run.runId);
  const mail = buildMail(run, loadChecklist(), prev, { reportUrl: process.env.REPORT_BASE_URL ? `${process.env.REPORT_BASE_URL.replace(/\/$/, '')}/${run.runId}/report.html` : '' });
  const res = await sendMail(cfg.mail, mail, attachmentsFor(dir), dry);
  console.log(dry ? `DRY RUN mail:\n  to: ${res.to.join(', ')}\n  subject: ${res.subject}\n  attachments: ${res.attachments.join(', ')}` : `Mail sent (${res.id})`);
  if (dry) fs.writeFileSync(path.join(dir, 'mail-preview.html'), mail.html);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const cfg = loadConfig();

  if (cmd === 'login') {
    const envName = args.env || 'staging';
    const env = cfg.envs[envName];
    if (!env) throw new Error(`Unknown env ${envName}`);
    await loginFlow(profileDirFor(ROOT, envName), env.adminHandle);
    return;
  }

  if (cmd === 'run') {
    const { runBatches } = require('./batch');
    const monitor = require('./monitor').forRun(ROOT, cfg);
    const envName = args.env || 'staging';
    let list = require('./config').themesForEnv(loadThemes(), envName, cfg.batchSize || 15);
    if (args.batches) { const b = String(args.batches).split(',').map(Number); list = list.filter((t) => b.includes(t.batch)); }
    if (args.themes) {
      const want = String(args.themes).split(',').map((s) => s.trim().toLowerCase());
      list = require('./config').themesForEnv(list.filter((t) => want.includes(t.name.toLowerCase())), envName, cfg.batchSize || 15); // an explicit list is batched too
    }
    if (!list.length) throw new Error('No themes selected (check --batches / --themes against config/themes.json).');
    console.log(`Config: ${cfg._file} | env: ${envName} | themes: ${list.length}`);
    const { run, runDir } = await runBatches({ root: ROOT, cfg, envName, themeList: list, checklist: loadChecklist(), opts: { skipClean: !!args['skip-clean'], skipWait: !!args['skip-wait'], keepThemes: !!args['keep-themes'], label: args.label ? String(args.label) : '', keepPictures: !!args['keep-pictures'], noTracker: !!args['no-tracker'], show: !!args.show, headless: !!args.headless, onProgress: monitor.onProgress, onFinish: monitor.onFinish } });
    console.log(`\nReport: ${path.join(runDir, 'report.html')}`);
    if (args.mail || args['dry-mail']) await doMail(cfg, run.runId, !!args['dry-mail']);
    return;
  }

  if (cmd === 'check') {
    const { runOnUrl } = require('./batch');
    if (!args.url) throw new Error('--url is required');
    const layouts = String(args.layouts || 'vertical').split(',');
    const { run, runDir } = await runOnUrl({ root: ROOT, cfg, url: args.url, name: args.name || 'theme', layouts, checklist: loadChecklist() });
    const f = require('./report/compare').flatten(run);
    const c = f.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
    console.log(JSON.stringify(c));
    f.filter((r) => r.status === 'fail' || r.status === 'error').forEach((r) => console.log(`  FAIL ${r.layout} ${r.id}: ${r.detail}`));
    console.log(`Report: ${path.join(runDir, 'report.html')}`);
    return;
  }

  if (cmd === 'report') {
    const { dir, run } = readRun(args.run, cfg);
    const prev = findPrevious(runsDir(ROOT, cfg), run.env, run.runId);
    fs.writeFileSync(path.join(dir, 'report.html'), render(run, loadChecklist(), prev));
    console.log(`Rebuilt ${path.join(dir, 'report.html')}`);
    return;
  }

  if (cmd === 'library') {
    const envName = args.env || 'staging';
    const env = cfg.envs[envName];
    if (!env) throw new Error('Unknown env ' + envName);
    const { openAdmin, profileDirFor } = require('./lib/browser');
    const themesApi = require('./admin/themes');
    const lib = require('./admin/library');
    const ctx = await openAdmin(profileDirFor(ROOT, envName), args.show ? 'show' : 'quiet');
    let live;
    try { live = await themesApi.listThemes(ctx, env); } finally { await ctx.close().catch(() => {}); }
    const wanted = require('./config').themesForEnv(loadThemes(), envName, cfg.batchSize || 15);
    const r = lib.saveLibrary(ROOT, cfg, envName, wanted, live);
    console.log(envName + ': ' + r.wanted + ' themes wanted, ' + r.inStore + ' in the store library');
    console.log('  present (' + r.present.length + '): ' + r.present.map((p) => p.name + (p.ids.length > 1 ? ' x' + p.ids.length : '')).join(', '));
    console.log('  missing (' + r.missing.length + '): ' + r.missing.join(', '));
    console.log('  other themes in the store: ' + (r.extras.map((e) => e.name).join(', ') || 'none'));
    return;
  }

  if (cmd === 'agent') {
    const ag = require('./agent');
    if (args.install) { const r = ag.installAgent(ROOT); console.log(r.ok ? r.message : 'Failed: ' + r.error); process.exitCode = r.ok ? 0 : 1; return; }
    if (args.uninstall) { const r = ag.uninstallAgent(); console.log(r.ok ? r.message : 'Failed: ' + r.error); return; }
    await ag.runAgent(ROOT, cfg);
    return;
  }

  if (cmd === 'watch') { await require('./monitor').watch(ROOT, cfg); return; }

  if (cmd === 'sync') {
    const r = await require('./monitor').syncNow(ROOT, cfg, { run: args.run, all: !!args.all });
    console.log(r.message);
    process.exitCode = r.ok ? 0 : 1; // not process.exit(): on Windows it can abort while a fetch is still closing
    return;
  }

  if (cmd === 'ui') {
    const port = Number(args.port) || 4173;
    await require('./server').listen(ROOT, port);
    console.log(`Dashboard: http://127.0.0.1:${port}  (this machine only; Ctrl+C to stop)`);
    return new Promise(() => {});
  }

  if (cmd === 'publish') {
    const r = require('./publish').publish(ROOT, cfg, args.out, { dashboardOnly: !!args['dashboard-only'] });
    console.log(`Published ${r.runs} run(s), ${r.files} files to ${r.out}`);
    return;
  }

  if (cmd === 'mail') { await doMail(cfg, args.run, !!args.dry); return; }

  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n/*', 'Commands:'));
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
