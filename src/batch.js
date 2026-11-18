// The weekly loop (docs/WORKFLOW.md section A): clean the store, install a batch of themes, test each theme with
// Tab 1 (layout) + Tab 2 (editor) + Tab 3 (preview), return to Vertical, exit, next theme.
const fs = require('fs');
const path = require('path');
const { chromium, openAdmin, profileDirFor, keyOf } = require('./lib/browser');
const design = require('./admin/design');
const editor = require('./admin/editor');
const themesApi = require('./admin/themes');
const { runPass } = require('./checks/run');
const { render } = require('./report/html');
const { findPrevious } = require('./report/compare');
const { runsDir } = require('./store/paths');
const { finalizeRun } = require('./store/archive');
const { dataDir } = require('./store/paths');
const { Progress } = require('./store/progress');

const LAYOUTS = ['vertical', 'horizontal', 'offcanvas'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 10);

function saveRun(runDir, run, checklist, prev) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.html'), render(run, checklist, prev));
}

async function testTheme({ ctx, browser, env, cfg, checklist, theme, themeId, runDir, designPage, log, prog }) {
  const key = keyOf(theme.name);
  const out = { name: theme.name, id: themeId, passes: [], setup: {} };
  const outDir = runDir;
  let ed = null;
  const step = (status, text) => { prog.setTheme(theme.name, { status, step: text }); };
  const add = (pass) => { out.passes.push(pass); prog.addResults(theme.name, pass.results); };
  try {
    // ---- Tab 1: Vertical first
    step('setup', 'Tab 1: setting the Vertical layout');
    await design.setLayout(designPage, 'vertical');
    // ---- Tab 2: editor
    step('setup', 'Tab 2: opening the theme editor');
    ed = await editor.openEditor(ctx, env, themeId);
    step('setup', 'Tab 2: turning on the Search & filter core embed');
    out.setup.core = await editor.enableCore(ed);
    step('setup', 'Tab 2: checking the Compatibility panel');
    const panel = await editor.checkCompatPanel(ed, outDir, `${key}/panel`, cfg.thresholds);
    step('setup', 'Tab 2: choosing the theme in Theme list, turning on Search suggestion, saving');
    const chosen = await editor.chooseThemeAndSave(ed, theme.name);
    out.setup.steps = chosen.steps;
    if (!chosen.ok) { out.setupFailed = { reason: chosen.reason, detail: chosen.detail }; return out; }
    // ---- Tab 3: Preview from the editor
    step('setup', 'Tab 2: opening Preview (Tab 3)');
    const prev = await editor.getPreviewUrl(ed, env, themeId);
    out.setup.previewVia = prev.via;
    prog.event(`${theme.name}: Tab 3 opened via ${prev.via}`);
    add({ layout: 'panel', viewport: 'desktop', results: [panel], video: null });

    const common = { browser, url: prev.url, outDir, thresholds: cfg.thresholds, keyword: cfg.keyword };
    for (const layout of LAYOUTS) {
      log(`  ${theme.name}: layout ${layout}`);
      if (layout !== 'vertical') { step('setup', `Tab 1: switching to ${layout}, then reloading Tab 3`); await design.setLayout(designPage, layout); }
      step('testing', `Checking the ${layout} layout (desktop)`);
      add(await runPass(Object.assign({}, common, { layout, viewportName: 'desktop', viewport: cfg.viewports.desktop, relDir: `${key}/${layout}-desktop`, videoDir: path.join(outDir, '_video') })));
      if (layout === 'offcanvas') {
        // mobile is always off-canvas; the desktop layout is irrelevant on a phone
        step('testing', 'Checking mobile');
        add(await runPass(Object.assign({}, common, { layout: 'mobile', viewportName: 'mobile', viewport: cfg.viewports.mobile, relDir: `${key}/mobile`, videoDir: path.join(outDir, '_video') })));
      }
    }
    log(`  ${theme.name}: search desktop + mobile`);
    step('testing', 'Checking search suggestion (desktop)');
    add(await runPass(Object.assign({}, common, { layout: 'search', viewportName: 'desktop', viewport: cfg.viewports.desktop, relDir: `${key}/search-desktop`, videoDir: path.join(outDir, '_video') })));
    step('testing', 'Checking search suggestion (mobile)');
    add(await runPass(Object.assign({}, common, { layout: 'search', viewportName: 'mobile', viewport: cfg.viewports.mobile, relDir: `${key}/search-mobile`, videoDir: path.join(outDir, '_video') })));
  } catch (e) {
    out.setupFailed = out.setupFailed || { reason: 'theme_run_failed', detail: String(e.message).slice(0, 240) };
  } finally {
    // end of each theme: Tab 1 back to Vertical, Tab 2 Exit
    prog.setTheme(theme.name, { step: 'Tab 1: putting the layout back to Vertical, leaving the editor' });
    try { await design.setLayout(designPage, 'vertical'); } catch (e) { out.setup.restoreFailed = String(e.message).slice(0, 160); }
    if (ed) await editor.exitEditor(ed, env).catch(() => {});
  }
  prog.setTheme(theme.name, out.setupFailed ? { status: 'failed', step: `${out.setupFailed.reason}: ${out.setupFailed.detail || ''}`.slice(0, 160) } : { status: 'done', step: 'finished' });
  return out;
}

async function runBatches({ root, cfg, envName, themeList, checklist, opts }) {
  const env = cfg.envs[envName];
  if (!env) throw new Error(`Unknown env "${envName}" (config has: ${Object.keys(cfg.envs).join(', ')})`);
  // a second run on the same day (for example a short test run) must not overwrite the first one
  let runId = `${stamp()}-${envName}`;
  if (fs.existsSync(path.join(runsDir(root, cfg), runId, 'results.json'))) runId += `-${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
  const runDir = path.join(runsDir(root, cfg), runId);
  const prev = findPrevious(runsDir(root, cfg), envName, runId);
  const run = { runId, env: envName, shop: env.shop, startedAt: new Date().toISOString(), themes: [] };
  const prog = new Progress(dataDir(root, cfg), { runId, env: envName, mode: opts.show ? 'visible windows' : 'background' }, opts.onProgress);
  prog.setThemes(themeList);
  const log = (m) => { console.log(m); prog.event(String(m).trim()); };
  let outcome = 'completed';
  const onSig = () => { prog.event('Stopped by the user'); prog.finish('cancelled'); process.exit(130); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  // background by default: no window, no focus. --show opens normal windows for debugging.
  const ctx = await openAdmin(profileDirFor(root, envName), !opts.show);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let designPage = null;
  try {
    prog.setPhase('login', 'Opening the Findter design page (Tab 1)');
    designPage = await design.openDesign(ctx, env);
    const batches = Array.from(new Set(themeList.map((t) => t.batch))).sort((a, b) => a - b);
    for (const b of batches) {
      const group = themeList.filter((t) => t.batch === b);
      log(`\nBatch ${b}: ${group.map((t) => t.name).join(', ')}`);
      // 1. clean the store (WORKFLOW A.2)
      prog.setPhase('batch', `Batch ${b}`);
      if (!opts.skipClean) {
        prog.setPhase('cleaning', `Batch ${b}: cleaning the store`);
        const lib = await themesApi.listThemes(ctx, env);
        for (const t of lib) { const r = await themesApi.deleteTheme(ctx, env, t.id, path.join(runDir, '_debug')); log(`  clean ${t.name || t.id}: ${r.ok ? 'deleted' : r.reason}`); }
      }
      // 2. install the batch (WORKFLOW A.3)
      const ids = new Map();
      let library = await themesApi.listThemes(ctx, env);
      prog.setPhase('installing', `Batch ${b}: installing themes`);
      for (const t of group) {
        prog.setTheme(t.name, { status: 'installing', step: 'Checking the theme library' });
        const known = library.find((x) => x.name && x.name.toLowerCase() === t.name.toLowerCase());
        if (known) { ids.set(t.name, known.id); log(`  ${t.name}: already in library (${known.id})`); continue; }
        const before = new Set(library.map((x) => x.id));
        const r = await themesApi.installAndFind(ctx, env, t.name, before);
        if (r.ok) { ids.set(t.name, r.id); library = await themesApi.listThemes(ctx, env); log(`  ${t.name}: installed (${r.id})`); }
        else { run.themes.push({ name: t.name, passes: [], setupFailed: { reason: r.reason, detail: r.detail } }); prog.setTheme(t.name, { status: 'failed', step: `install failed: ${r.reason}` }); log(`  ${t.name}: install failed (${r.reason})`); }
      }
      if (ids.size && !opts.skipWait) { prog.setPhase('waiting', 'Waiting 3 minutes so every installed theme is fully usable'); log('  waiting 3 minutes so every theme is fully usable...'); await sleep(180000); }
      prog.setPhase('testing', `Batch ${b}: testing`);
      // 3. test each theme (WORKFLOW A.4)
      for (const t of group) {
        if (!ids.has(t.name)) continue;
        log(` Testing ${t.name}`);
        run.themes.push(await testTheme({ ctx, browser, env, cfg, checklist, theme: t, themeId: ids.get(t.name), runDir, designPage, log, prog }));
        saveRun(runDir, run, checklist, prev); // after every theme, so a crash keeps what was done
      }
    }
  } catch (e) {
    outcome = 'failed';
    prog.event(`Run failed: ${String(e.message).split(/[\r\n]/)[0].slice(0, 200)}`);
    prog.finish('failed');
    throw e;
  } finally {
    await browser.close().catch(() => {});
    await ctx.close().catch(() => {});
    saveRun(runDir, run, checklist, prev);
    try { fs.rmSync(path.join(runDir, '_video'), { recursive: true, force: true }); } catch (e) { /* leftovers */ }
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
  }
  prog.setPhase('finishing', 'Writing the report, summary and issue tracker');
  const fin = finalizeRun({ root, cfg, run, checklist, trackIssues: true });
  prog.event(`Finished: ${fin.summary.failedChecks} failing checks on ${fin.summary.themesWithIssues}/${fin.summary.themesTested} themes`);
  prog.finish(outcome);
  if (opts.onFinish) {
    try { await opts.onFinish({ run, runDir, fin }); } catch (e) { console.log('Upload to the monitor failed: ' + e.message); }
  }
  return { run, runDir, prev, fin };
}

// No admin at all: run the passes on one storefront URL (for development and for a quick look at one theme).
async function runOnUrl({ root, cfg, url, name, layouts, checklist }) {
  const runId = `${stamp()}-url-${keyOf(name)}`;
  const runDir = path.join(runsDir(root, cfg), runId);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const out = { name, passes: [], setup: { previewVia: 'url given on the command line' } };
  try {
    const common = { browser, url, outDir: runDir, thresholds: cfg.thresholds, keyword: cfg.keyword, videoDir: path.join(runDir, '_video') };
    const key = keyOf(name);
    for (const layout of layouts) {
      if (layout === 'mobile') out.passes.push(await runPass(Object.assign({}, common, { layout, viewportName: 'mobile', viewport: cfg.viewports.mobile, relDir: `${key}/mobile` })));
      else if (layout === 'search') {
        out.passes.push(await runPass(Object.assign({}, common, { layout, viewportName: 'desktop', viewport: cfg.viewports.desktop, relDir: `${key}/search-desktop` })));
        out.passes.push(await runPass(Object.assign({}, common, { layout, viewportName: 'mobile', viewport: cfg.viewports.mobile, relDir: `${key}/search-mobile` })));
      } else out.passes.push(await runPass(Object.assign({}, common, { layout, viewportName: 'desktop', viewport: cfg.viewports.desktop, relDir: `${key}/${layout}-desktop` })));
    }
  } finally { await browser.close().catch(() => {}); }
  const run = { runId, env: 'url', shop: new URL(url).host, startedAt: new Date().toISOString(), themes: [out] };
  saveRun(runDir, run, checklist, null);
  try { fs.rmSync(path.join(runDir, '_video'), { recursive: true, force: true }); } catch (e) { /* leftovers */ }
  finalizeRun({ root, cfg, run, checklist, trackIssues: false });
  return { run, runDir };
}

module.exports = { runBatches, runOnUrl, saveRun };
