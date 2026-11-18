// The weekly loop (docs/WORKFLOW.md section A) with two "pivot" themes (Horizon and Dawn on staging):
//   1. the live pivot (Horizon) is tested first, while it is live;
//   2. the other pivot (Dawn) is installed and tested on its own as a draft;
//   3. the remaining themes are tested in batches of 15 (install, wait, test each, delete). Before each batch the pivots swap:
//      one of them is published (live), the other stays as a draft, so the store ALWAYS has a live theme and is never emptied;
//   4. at the end Horizon is published again and the test themes are deleted (the pivots are never deleted).
// Without pivots in the environment config the old loop is used (batches of 15, whatever is live stays live).
const fs = require('fs');
const path = require('path');
const { chromium, openAdmin, profileDirFor, keyOf, norm } = require('./lib/browser');
const design = require('./admin/design');
const editor = require('./admin/editor');
const themesApi = require('./admin/themes');
const { runPass } = require('./checks/run');
const { render } = require('./report/html');
const { findPrevious } = require('./report/compare');
const { runsDir, dataDir } = require('./store/paths');
const { finalizeRun } = require('./store/archive');
const { Progress } = require('./store/progress');

const LAYOUTS = ['vertical', 'horizontal', 'offcanvas'];
const envName = (env) => String(env.adminHandle || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 10);

// Pauses between actions. Generous on purpose: Shopify's admin is slow to settle after an install, a delete or a publish.
const DELAYS = { afterInstall: 12000, afterClean: 10000, beforeEdit: 6000, afterExit: 4000, afterPublish: 15000, installWait: 180000 };

function saveRun(runDir, run, checklist, prev) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.html'), render(run, checklist, prev));
}

// Which themes are pivots, which go in which batch. Pure, so it can be tested.
function planRun(themeList, env, size) {
  const names = (env && env.pivots) || [];
  const byName = (n) => themeList.find((t) => norm(t.name) === norm(n));
  const pivots = names.map(byName).filter(Boolean);
  const isPivot = (t) => pivots.some((p) => p.name === t.name);
  const rest = themeList.filter((t) => !isPivot(t));
  const n = Math.max(1, size || 15);
  const batches = [];
  for (let i = 0; i < rest.length; i += n) batches.push(rest.slice(i, i + n));
  return { pivots, rest, batches };
}

async function testTheme({ ctx, browser, env, cfg, checklist, theme, themeId, runDir, designPage, log, prog, delays }) {
  const key = keyOf(theme.name);
  const out = { name: theme.name, id: themeId, passes: [], setup: {} };
  const outDir = runDir;
  let ed = null;
  const step = (status, text) => { prog.setTheme(theme.name, { status, step: text }); };
  const add = (pass) => {
    out.passes.push(pass);
    prog.addResults(theme.name, pass.results);
  };
  const blocked = (passes) => passes.find((p) => p.blocked);
  try {
    // ---- Tab 1: Vertical first
    step('setup', 'Tab 1: setting the Vertical layout');
    await design.setLayout(designPage, 'vertical');
    // ---- Tab 2: editor
    await sleep(delays.beforeEdit);
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
    add({ layout: 'panel', viewport: 'desktop', results: [panel] });

    const common = { browser, url: prev.url, outDir, thresholds: cfg.thresholds, keyword: cfg.keyword, cookies: prev.cookies, password: env.storefrontPassword || process.env[`STOREFRONT_PASSWORD_${envName(env)}`] };
    const P = (layout, viewportName, rel) => runPass(Object.assign({}, common, { layout, viewportName, viewport: cfg.viewports[viewportName], relDir: `${key}/${rel}` }));
    // The passes that do not depend on each other run at the same time (separate browser contexts): the search passes work
    // with any layout, and mobile is always off-canvas. Layout changes themselves stay one after the other.
    log(`  ${theme.name}: vertical + search (desktop and mobile)`);
    step('testing', 'Checking vertical layout, search desktop and search mobile (at the same time)');
    let group = await Promise.all([P('vertical', 'desktop', 'vertical-desktop'), P('search', 'desktop', 'search-desktop'), P('search', 'mobile', 'search-mobile')]);
    group.forEach(add);
    if (blocked(group)) throw Object.assign(new Error(blocked(group).blocked), { reason: 'storefront_blocked' });

    log(`  ${theme.name}: horizontal`);
    step('setup', 'Tab 1: switching to horizontal, then reloading Tab 3');
    await design.setLayout(designPage, 'horizontal');
    step('testing', 'Checking the horizontal layout (desktop)');
    group = [await P('horizontal', 'desktop', 'horizontal-desktop')];
    group.forEach(add);

    log(`  ${theme.name}: off-canvas + mobile`);
    step('setup', 'Tab 1: switching to off-canvas, then reloading Tab 3');
    await design.setLayout(designPage, 'offcanvas');
    step('testing', 'Checking off-canvas (desktop) and mobile (at the same time)');
    group = await Promise.all([P('offcanvas', 'desktop', 'offcanvas-desktop'), P('mobile', 'mobile', 'mobile')]);
    group.forEach(add);
  } catch (e) {
    out.setupFailed = out.setupFailed || { reason: e.reason || 'theme_run_failed', detail: String(e.message).slice(0, 240) };
  } finally {
    // end of each theme: Tab 1 back to Vertical, Tab 2 Exit
    prog.setTheme(theme.name, { step: 'Tab 1: putting the layout back to Vertical, leaving the editor' });
    try { await design.setLayout(designPage, 'vertical'); } catch (e) { out.setup.restoreFailed = String(e.message).slice(0, 160); }
    if (ed) await editor.exitEditor(ed, env).catch(() => {});
    await sleep(delays.afterExit);
  }
  prog.setTheme(theme.name, out.setupFailed ? { status: 'failed', step: `${out.setupFailed.reason}: ${out.setupFailed.detail || ''}`.slice(0, 160) } : { status: 'done', step: 'finished' });
  return out;
}

// The browser was closed before, so open a short one just to clean up / restore.
async function afterRun(root, cfg, envNameStr, runDir, log, fn) {
  const ctx = await openAdmin(profileDirFor(root, envNameStr), 'quiet');
  try { return await fn(ctx, cfg.envs[envNameStr]); } finally { await ctx.close().catch(() => {}); }
}

async function runBatches({ root, cfg, envName: envKey, themeList, checklist, opts }) {
  const env = cfg.envs[envKey];
  if (!env) throw new Error(`Unknown env "${envKey}" (config has: ${Object.keys(cfg.envs).join(', ')})`);
  const delays = Object.assign({}, DELAYS, cfg.delays || {}, opts.skipWait ? { installWait: 0 } : {});
  // a second run on the same day (for example a short test run) must not overwrite the first one
  let runId = `${stamp()}-${envKey}`;
  if (fs.existsSync(path.join(runsDir(root, cfg), runId, 'results.json'))) runId += `-${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
  const runDir = path.join(runsDir(root, cfg), runId);
  const prev = findPrevious(runsDir(root, cfg), envKey, runId);
  const run = { runId, env: envKey, shop: env.shop, startedAt: new Date().toISOString(), themes: [] };
  const prog = new Progress(dataDir(root, cfg), { runId, env: envKey, mode: opts.show ? 'visible windows' : opts.headless ? 'headless' : 'background (off-screen window)' }, opts.onProgress);
  prog.setThemes(themeList);
  const log = (m) => { console.log(m); prog.event(String(m).trim()); };
  let outcome = 'completed';
  const onSig = () => { prog.event('Stopped by the user'); prog.finish('cancelled'); process.exit(130); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const ctx = await openAdmin(profileDirFor(root, envKey), opts.show ? 'show' : opts.headless ? 'headless' : 'quiet');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let designPage = null;
  const dbg = path.join(runDir, '_debug');
  const plan = planRun(themeList, env, cfg.batchSize || 15);
  const pivotIds = new Map(); // name -> id
  let rotate = plan.pivots.length === 2;

  const record = async (t, id, asEnv) => {
    log(` Testing ${t.name}`);
    run.themes.push(await testTheme({ ctx, browser, env: asEnv || env, cfg, checklist, theme: t, themeId: id, runDir, designPage, log, prog, delays }));
    saveRun(runDir, run, checklist, prev); // after every theme, so a crash keeps what was done
  };
  // install one theme from the Theme Store; returns its id or null (and records the failure)
  const install = async (t, library, canClean) => {
    prog.setTheme(t.name, { status: 'installing', step: 'Installing from the Theme Store' });
    let r = await themesApi.installAndFind(ctx, env, t.name, new Set(library.map((x) => x.id)));
    if (!r.ok && r.reason === 'library_full' && canClean) {
      log(`  ${t.name}: the store is full, cleaning and trying once more`);
      await themesApi.cleanDrafts(ctx, env, log, dbg, Array.from(pivotIds.values()));
      await sleep(delays.afterClean);
      r = await themesApi.installAndFind(ctx, env, t.name, new Set((await themesApi.listThemes(ctx, env)).map((x) => x.id)));
    }
    if (r.ok) { log(`  ${t.name}: installed (${r.id})`); await sleep(delays.afterInstall); return r.id; }
    run.themes.push({ name: t.name, passes: [], setupFailed: { reason: r.reason, detail: r.detail } });
    prog.setTheme(t.name, { status: 'failed', step: `install failed: ${r.reason}` });
    log(`  ${t.name}: install failed (${r.reason})`);
    return null;
  };
  const makeLive = async (name) => {
    const id = pivotIds.get(name);
    if (!id) return false;
    prog.setPhase('publishing', `Publishing ${name} so the store keeps a live theme`);
    const r = await themesApi.publishTheme(ctx, env, id, dbg);
    log(`  ${name} live: ${r.ok ? (r.note || 'published') : 'could not publish (' + r.reason + '), the previous live theme stays'}`);
    if (r.ok) await sleep(delays.afterPublish);
    return r.ok;
  };

  try {
    prog.setPhase('login', 'Opening the Findter design page (Tab 1)');
    designPage = await design.openDesign(ctx, env);

    if (plan.pivots.length) {
      const [A, B] = [plan.pivots[0], plan.pivots[1]];
      let live = await themesApi.liveTheme(ctx, env);
      log(`Live theme at the start: ${live ? live.name : '(none found)'}`);
      // ---- 1. the pivot that is live now (Horizon) is tested first, while live
      if (live && norm(live.name) === norm(A.name)) {
        pivotIds.set(A.name, live.id);
        prog.setPhase('testing', `${A.name} (live theme) first`);
        await record(A, live.id, Object.assign({}, env, { allowLiveTheme: true }));
      } else { log(`  ${A.name} is not the live theme: pivots are skipped (the live theme stays as it is)`); rotate = false; }
      // ---- 2. the second pivot (Dawn) as a draft, on its own
      if (B && rotate) {
        prog.setPhase('installing', `Installing ${B.name}`);
        const lib = await themesApi.listThemes(ctx, env);
        const have = lib.find((x) => !x.live && norm(x.name) === norm(B.name));
        const id = have ? have.id : await install(B, lib, false);
        if (id) {
          pivotIds.set(B.name, id);
          if (!have && delays.installWait) { prog.setPhase('waiting', `Waiting for ${B.name} to be usable`); await sleep(delays.installWait); }
          prog.setPhase('testing', `${B.name} (draft) on its own`);
          await record(B, id);
        } else rotate = false;
      }
    }
    if (!plan.pivots.length || !rotate) { // no rotation: the old loop over the non-pivot themes (or all of them)
      if (plan.pivots.length) plan.batches = planRun(themeList.filter((t) => !pivotIds.has(t.name) && !run.themes.some((r) => r.name === t.name)), {}, cfg.batchSize || 15).batches;
    }

    // ---- 3. batches
    for (let bi = 0; bi < plan.batches.length; bi++) {
      const group = plan.batches[bi];
      log(`\nBatch ${bi + 1} of ${plan.batches.length}: ${group.map((t) => t.name).join(', ')}`);
      if (rotate) await makeLive(bi % 2 === 0 ? plan.pivots[1].name : plan.pivots[0].name); // Dawn live for batch 1, Horizon for batch 2, ...
      if (!opts.skipClean) {
        prog.setPhase('cleaning', `Batch ${bi + 1}: deleting the draft themes of the previous batch`);
        const c = await themesApi.cleanDrafts(ctx, env, log, dbg, Array.from(pivotIds.values()));
        log(`  store cleaned: ${c.deleted} draft theme(s) deleted${c.failed.length ? ', ' + c.failed.length + ' could not be deleted' : ''}`);
        await sleep(delays.afterClean);
      }
      prog.setPhase('installing', `Batch ${bi + 1}: installing ${group.length} themes`);
      const ids = new Map();
      let library = await themesApi.listThemes(ctx, env);
      for (const t of group) {
        const known = opts.skipClean ? library.find((x) => !x.live && x.name && norm(x.name) === norm(t.name)) : null;
        if (known) { ids.set(t.name, known.id); log(`  ${t.name}: already in library (${known.id})`); continue; }
        const id = await install(t, library, !opts.skipClean);
        if (id) { ids.set(t.name, id); library = await themesApi.listThemes(ctx, env); }
      }
      if (ids.size && delays.installWait) { prog.setPhase('waiting', 'Waiting 3 minutes so every installed theme is fully usable'); log('  waiting 3 minutes so every theme is fully usable...'); await sleep(delays.installWait); }
      prog.setPhase('testing', `Batch ${bi + 1} of ${plan.batches.length}: testing`);
      for (const t of group) { if (ids.has(t.name)) await record(t, ids.get(t.name)); }
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
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
  }
  // ---- 4. restore: Horizon live again, test themes deleted (the pivots are kept)
  if (outcome === 'completed') {
    try {
      prog.setPhase('cleaning', 'Restoring the live theme and deleting the test themes');
      await afterRun(root, cfg, envKey, runDir, log, async (c2, e2) => {
        if (rotate && pivotIds.get(plan.pivots[0].name)) {
          const r = await themesApi.publishTheme(c2, e2, pivotIds.get(plan.pivots[0].name), dbg);
          log(`  ${plan.pivots[0].name} live again: ${r.ok ? 'yes' : 'could not publish (' + r.reason + ')'}`);
        }
        if (!opts.skipClean && !opts.keepThemes) {
          const c = await themesApi.cleanDrafts(c2, e2, log, dbg, Array.from(pivotIds.values()));
          log(`  store cleaned at the end: ${c.deleted} draft theme(s) deleted`);
        }
      });
    } catch (e) { log('Final restore failed: ' + e.message); }
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
    const common = { browser, url, outDir: runDir, thresholds: cfg.thresholds, keyword: cfg.keyword };
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
  finalizeRun({ root, cfg, run, checklist, trackIssues: false });
  return { run, runDir };
}

module.exports = { runBatches, runOnUrl, saveRun, planRun, DELAYS };
