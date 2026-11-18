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

const LAYOUTS = ['vertical', 'horizontal', 'offcanvas'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 10);

function saveRun(runDir, run, checklist, prev) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.html'), render(run, checklist, prev));
}

async function testTheme({ ctx, browser, env, cfg, checklist, theme, themeId, runDir, designPage, log }) {
  const key = keyOf(theme.name);
  const out = { name: theme.name, id: themeId, passes: [], setup: {} };
  const outDir = runDir;
  let ed = null;
  try {
    // ---- Tab 1: Vertical first
    await design.setLayout(designPage, 'vertical');
    // ---- Tab 2: editor
    ed = await editor.openEditor(ctx, env, themeId);
    out.setup.core = await editor.enableCore(ed);
    const panel = await editor.checkCompatPanel(ed, outDir, `${key}/panel`, cfg.thresholds);
    const chosen = await editor.chooseThemeAndSave(ed, theme.name);
    out.setup.steps = chosen.steps;
    if (!chosen.ok) { out.setupFailed = { reason: chosen.reason, detail: chosen.detail }; return out; }
    // ---- Tab 3: Preview from the editor
    const prev = await editor.getPreviewUrl(ed, env, themeId);
    out.setup.previewVia = prev.via;
    out.passes.push({ layout: 'panel', viewport: 'desktop', results: [panel], video: null });

    const common = { browser, url: prev.url, outDir, thresholds: cfg.thresholds, keyword: cfg.keyword };
    for (const layout of LAYOUTS) {
      log(`  ${theme.name}: layout ${layout}`);
      if (layout !== 'vertical') await design.setLayout(designPage, layout);
      out.passes.push(await runPass(Object.assign({}, common, { layout, viewportName: 'desktop', viewport: cfg.viewports.desktop, relDir: `${key}/${layout}-desktop`, videoDir: path.join(outDir, '_video') })));
      if (layout === 'offcanvas') {
        // mobile is always off-canvas; the desktop layout is irrelevant on a phone
        out.passes.push(await runPass(Object.assign({}, common, { layout: 'mobile', viewportName: 'mobile', viewport: cfg.viewports.mobile, relDir: `${key}/mobile`, videoDir: path.join(outDir, '_video') })));
      }
    }
    log(`  ${theme.name}: search desktop + mobile`);
    out.passes.push(await runPass(Object.assign({}, common, { layout: 'search', viewportName: 'desktop', viewport: cfg.viewports.desktop, relDir: `${key}/search-desktop`, videoDir: path.join(outDir, '_video') })));
    out.passes.push(await runPass(Object.assign({}, common, { layout: 'search', viewportName: 'mobile', viewport: cfg.viewports.mobile, relDir: `${key}/search-mobile`, videoDir: path.join(outDir, '_video') })));
  } catch (e) {
    out.setupFailed = out.setupFailed || { reason: 'theme_run_failed', detail: String(e.message).slice(0, 240) };
  } finally {
    // end of each theme: Tab 1 back to Vertical, Tab 2 Exit
    try { await design.setLayout(designPage, 'vertical'); } catch (e) { out.setup.restoreFailed = String(e.message).slice(0, 160); }
    if (ed) await editor.exitEditor(ed, env).catch(() => {});
  }
  return out;
}

async function runBatches({ root, cfg, envName, themeList, checklist, opts }) {
  const env = cfg.envs[envName];
  if (!env) throw new Error(`Unknown env "${envName}" (config has: ${Object.keys(cfg.envs).join(', ')})`);
  const runId = `${stamp()}-${envName}`;
  const runDir = path.join(root, 'runs', runId);
  const prev = findPrevious(path.join(root, 'runs'), envName, runId);
  const run = { runId, env: envName, shop: env.shop, startedAt: new Date().toISOString(), themes: [] };
  const log = (m) => console.log(m);
  const ctx = await openAdmin(profileDirFor(root, envName), !!opts.headless);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let designPage = null;
  try {
    designPage = await design.openDesign(ctx, env);
    const batches = Array.from(new Set(themeList.map((t) => t.batch))).sort((a, b) => a - b);
    for (const b of batches) {
      const group = themeList.filter((t) => t.batch === b);
      log(`\nBatch ${b}: ${group.map((t) => t.name).join(', ')}`);
      // 1. clean the store (WORKFLOW A.2)
      if (!opts.skipClean) {
        const lib = await themesApi.listThemes(ctx, env);
        for (const t of lib) { const r = await themesApi.deleteTheme(ctx, env, t.id, path.join(runDir, '_debug')); log(`  clean ${t.name || t.id}: ${r.ok ? 'deleted' : r.reason}`); }
      }
      // 2. install the batch (WORKFLOW A.3)
      const ids = new Map();
      let library = await themesApi.listThemes(ctx, env);
      for (const t of group) {
        const known = library.find((x) => x.name && x.name.toLowerCase() === t.name.toLowerCase());
        if (known) { ids.set(t.name, known.id); log(`  ${t.name}: already in library (${known.id})`); continue; }
        const before = new Set(library.map((x) => x.id));
        const r = await themesApi.installAndFind(ctx, env, t.name, before);
        if (r.ok) { ids.set(t.name, r.id); library = await themesApi.listThemes(ctx, env); log(`  ${t.name}: installed (${r.id})`); }
        else { run.themes.push({ name: t.name, passes: [], setupFailed: { reason: r.reason, detail: r.detail } }); log(`  ${t.name}: install failed (${r.reason})`); }
      }
      if (ids.size && !opts.skipWait) { log('  waiting 3 minutes so every theme is fully usable...'); await sleep(180000); }
      // 3. test each theme (WORKFLOW A.4)
      for (const t of group) {
        if (!ids.has(t.name)) continue;
        log(` Testing ${t.name}`);
        run.themes.push(await testTheme({ ctx, browser, env, cfg, checklist, theme: t, themeId: ids.get(t.name), runDir, designPage, log }));
        saveRun(runDir, run, checklist, prev); // after every theme, so a crash keeps what was done
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await ctx.close().catch(() => {});
    saveRun(runDir, run, checklist, prev);
    try { fs.rmSync(path.join(runDir, '_video'), { recursive: true, force: true }); } catch (e) { /* leftovers */ }
  }
  return { run, runDir, prev };
}

// No admin at all: run the passes on one storefront URL (for development and for a quick look at one theme).
async function runOnUrl({ root, cfg, url, name, layouts, checklist }) {
  const runId = `${stamp()}-url-${keyOf(name)}`;
  const runDir = path.join(root, 'runs', runId);
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
  return { run, runDir };
}

module.exports = { runBatches, runOnUrl, saveRun };
