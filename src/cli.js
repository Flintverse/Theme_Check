#!/usr/bin/env node
/*
 * node src/cli.js login  --env staging|prod            one-time Shopify admin login (saved in .profile-<env>/, no password stored)
 * node src/cli.js run    --env staging [--batches 1,2] [--themes "Dawn,Craft"] [--skip-clean] [--skip-wait] [--mail] [--dry-mail]
 *                                                     the weekly loop (docs/WORKFLOW.md): clean, install batch, test, report
 * node src/cli.js check  --url <storefront url> [--name dawn] [--layouts vertical,horizontal,offcanvas,mobile,search]
 *                                                     no admin: run the checklist on one storefront URL
 * node src/cli.js report --run 2026-11-18-staging      rebuild report.html from results.json
 * node src/cli.js mail   --run 2026-11-18-staging [--dry]  send (or print) the Gmail summary
 * node src/cli.js ui     [--port 4173]                 local dashboard: themes, schedule, run now, history, issue tracker
 * node src/cli.js publish [--out site] [--with-videos]   read-only copy of the dashboard for a static host
 */
const fs = require('fs');
const path = require('path');
const { loginFlow, profileDirFor } = require('./lib/browser');
const { render } = require('./report/html');
const { findPrevious } = require('./report/compare');
const { buildMail, sendMail, attachmentsFor } = require('./mail');

const { runsDir } = require('./store/paths');

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
    const envName = args.env || 'staging';
    let list = loadThemes().filter((t) => t.enabled !== false);
    if (args.batches) { const b = String(args.batches).split(',').map(Number); list = list.filter((t) => b.includes(t.batch)); }
    if (args.themes) {
      const want = String(args.themes).split(',').map((s) => s.trim().toLowerCase());
      list = list.filter((t) => want.includes(t.name.toLowerCase()));
      list.forEach((t) => { t.batch = 1; }); // an explicit list runs as one batch
    }
    if (!list.length) throw new Error('No themes selected (check --batches / --themes against config/themes.json).');
    console.log(`Config: ${cfg._file} | env: ${envName} | themes: ${list.length}`);
    const { run, runDir } = await runBatches({ root: ROOT, cfg, envName, themeList: list, checklist: loadChecklist(), opts: { skipClean: !!args['skip-clean'], skipWait: !!args['skip-wait'], headless: !!args.headless } });
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

  if (cmd === 'ui') {
    const port = Number(args.port) || 4173;
    await require('./server').listen(ROOT, port);
    console.log(`Dashboard: http://127.0.0.1:${port}  (this machine only; Ctrl+C to stop)`);
    return new Promise(() => {});
  }

  if (cmd === 'publish') {
    const r = require('./publish').publish(ROOT, cfg, args.out, { withVideos: !!args['with-videos'] });
    console.log(`Published ${r.runs} run(s), ${r.files} files to ${r.out}`);
    return;
  }

  if (cmd === 'mail') { await doMail(cfg, args.run, !!args.dry); return; }

  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n/*', 'Commands:'));
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
