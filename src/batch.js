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
const T = require('./lib/time');
const stamp = () => T.today(); // the day in UTC+7

// Pauses between actions. Generous on purpose: Shopify's admin is slow to settle after an install, a delete or a publish.
// One theme at a time: install, wait until it shows up and can be edited, test, delete, next. The waits are generous on purpose.
//   installWait  = pause after the install lands, before looking for the theme
//   readyPoll    = how often the theme list is read while waiting; readyTimeout = how long to wait at most
//   afterListed  = extra pause once the theme is listed, before its editor is tried
const DELAYS = { afterInstall: 20000, afterClean: 15000, beforeEdit: 6000, afterExit: 4000, afterPublish: 15000, installWait: 90000, afterListed: 45000, readyPoll: 30000, readyTimeout: 600000 };

function saveRun(runDir, run, checklist, prev) {
  fs.mkdirSync(runDir, { recursive: true });
  // write to a temporary name first, so a reader (the dashboard sync) never sees half a file
  const put = (name, text) => { const f = path.join(runDir, name); fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); };
  put('results.json', JSON.stringify(run, null, 2));
  const ovr = require('./store/overrides'); // the report shows the manual verdicts; results.json stays the script's own
  require('./report/write').writeReports(runDir, ovr.applyOverrides(run, ovr.readOverrides(runDir)), checklist, prev);
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

async function testTheme({ ctx, browser, env, cfg, checklist, theme, themeId, runDir, designPage, log, prog, delays, partial }) {
  const key = keyOf(theme.name);
  const out = { name: theme.name, id: themeId, passes: [], setup: {} };
  const outDir = runDir;
  let ed = null;
  const step = (status, text) => { prog.setTheme(theme.name, { status, step: text }); };
  const add = (pass) => {
    out.passes.push(pass);
    prog.addResults(theme.name, pass.results);
    if (partial) { try { partial(out); } catch (e) { /* saving a partial result must never stop the test */ } } // the page can show this theme's results right now
  };
  const blocked = (passes) => passes.find((p) => p.blocked);
  try {
    // ---- Tab 1: Vertical first
    // not counted in the Time column: the clock starts when the theme editor is opened (status 'setup' below)
    step('preparing', 'Tab 1: setting the Vertical layout');
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
  const delays = Object.assign({}, DELAYS, cfg.delays || {}, opts.skipWait ? { installWait: 0, afterListed: 5000 } : {});
  // a second run on the same day (for example a short test run) must not overwrite the first one
  let runId = `${stamp()}-${envKey}` + (opts.label ? '-' + keyOf(opts.label) : '');
  if (fs.existsSync(path.join(runsDir(root, cfg), runId, 'results.json'))) runId += `-${T.fmtTime(new Date()).slice(0, 5).replace(':', '')}`;
  const runDir = path.join(runsDir(root, cfg), runId);
  const prev = findPrevious(runsDir(root, cfg), envKey, runId);
  const run = { runId, env: envKey, shop: env.shop, startedAt: new Date().toISOString(), themes: [] };
  const prog = new Progress(dataDir(root, cfg), { runId, env: envKey, mode: opts.show ? 'visible windows' : opts.headless ? 'headless' : 'background (off-screen window)' }, opts.onProgress);
  prog.setThemes(themeList);
  const log = (m) => { console.log(`[${T.fmtTime(new Date())}] ${String(m).replace(/^\n/, '')}`); prog.event(String(m).trim()); };
  let outcome = 'completed';
  let ctxRef = null, browserRef = null;
  const onSig = () => { // close Chrome properly first, so it does not report a crash and ask to restore its tabs next time
    prog.event('Stopped by the user'); prog.finish('cancelled');
    const bye = () => process.exit(130);
    setTimeout(bye, 6000).unref();
    Promise.all([browserRef && browserRef.close().catch(() => {}), ctxRef && ctxRef.close().catch(() => {})]).then(bye, bye);
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const ctx = await openAdmin(profileDirFor(root, envKey), opts.show ? 'show' : opts.headless ? 'headless' : 'quiet');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  ctxRef = ctx; browserRef = browser;
  let designPage = null;
  const dbg = path.join(runDir, '_debug');
  const keepNames = env.keepThemes || env.pivots || []; // never deleted, even as drafts (Horizon: the store's base theme)
  let liveInfo = null; // the published theme of the store: never deleted, never changed unless it is the theme to test

  const record = async (t, id, asEnv) => {
    log(` Testing ${t.name}`);
    const keep = (o) => { const i = run.themes.findIndex((x) => x.name === o.name); if (i < 0) run.themes.push(o); else run.themes[i] = o; };
    const partial = (o) => { keep(o); saveRun(runDir, run, checklist, prev); };
    keep(await testTheme({ ctx, browser, env: asEnv || env, cfg, checklist, theme: t, themeId: id, runDir, designPage, log, prog, delays, partial }));
    saveRun(runDir, run, checklist, prev); // after every theme, so a crash keeps what was done
  };
  // install one theme from the Theme Store; returns its id or null (and records the failure)
  const install = async (t, library, canClean) => {
    prog.setTheme(t.name, { status: 'installing', step: 'Installing from the Theme Store' });
    let r = await themesApi.installAndFind(ctx, env, t.name, new Set(library.map((x) => x.id)));
    if (!r.ok && r.reason === 'library_full' && canClean) {
      log(`  ${t.name}: the store is full, cleaning and trying once more`);
      await themesApi.cleanDrafts(ctx, env, log, dbg, liveInfo ? [liveInfo.id] : [], keepNames);
      await sleep(delays.afterClean);
      r = await themesApi.installAndFind(ctx, env, t.name, new Set((await themesApi.listThemes(ctx, env)).map((x) => x.id)));
    }
    if (r.ok) { prog.setTheme(t.name, { status: 'installed', step: 'Installed. Waiting until it can be edited' }); log(`  ${t.name}: installed (${r.id})`); await sleep(delays.afterInstall); return r.id; }
    run.themes.push({ name: t.name, passes: [], setupFailed: { reason: r.reason, detail: r.detail } });
    prog.setTheme(t.name, { status: 'failed', step: `install failed: ${r.reason}` });
    log(`  ${t.name}: install failed (${r.reason})`);
    return null;
  };
  // Wait until a theme that was just installed is really usable: it is listed with its name, a pause, and its editor opens.
  const waitUsable = async (t, id) => {
    prog.setPhase('waiting', `Waiting until ${t.name} shows up in the theme list and can be edited`);
    prog.setTheme(t.name, { status: 'installed', step: 'Installed. Waiting until it shows in the theme list...' });
    if (delays.installWait) { log(`  ${t.name}: waiting ${Math.round(delays.installWait / 1000)} s before looking for it in the theme list`); await sleep(delays.installWait); }
    const until = Date.now() + (delays.readyTimeout || 600000);
    let listed = false, lastDetail = '';
    for (let n = 1; Date.now() < until; n++) {
      const lib = await themesApi.listThemes(ctx, env).catch(() => []);
      listed = lib.some((x) => x.id === id && x.name);
      if (listed) {
        prog.setTheme(t.name, { step: 'Shown in the theme list. Checking that its editor opens...' });
        await sleep(delays.afterListed);
        const probe = await editor.probeEditor(ctx, env, id);
        if (probe.ok) { log(`  ${t.name}: ready, it is listed and its editor opens (look ${n})`); return { ok: true }; }
        lastDetail = probe.detail;
        log(`  ${t.name}: listed, but not editable yet (${probe.detail})`);
        prog.setTheme(t.name, { step: 'Not editable yet: ' + probe.detail });
      } else {
        lastDetail = 'not in the theme list';
        prog.setTheme(t.name, { step: 'Not in the theme list yet, looking again soon...' });
      }
      await sleep(delays.readyPoll);
    }
    return { ok: false, reason: listed ? 'editor_not_ready' : 'not_listed', detail: `${lastDetail} after ${Math.round((delays.readyTimeout || 600000) / 60000)} minutes` };
  };

  try {
    prog.setPhase('login', 'Opening the Findter design page (Tab 1)');
    designPage = await design.openDesign(ctx, env);
    liveInfo = await themesApi.liveTheme(ctx, env);
    log(`Live theme at the start: ${liveInfo ? liveInfo.name : '(none found)'}. It is never deleted.`);
    if (!liveInfo) throw new Error('No live (published) theme was found, so nothing is installed or deleted.');

    if (!opts.skipClean) { // leftovers of an earlier run (never the live theme)
      prog.setPhase('cleaning', 'Deleting draft themes left over from earlier runs');
      const c = await themesApi.cleanDrafts(ctx, env, log, dbg, [liveInfo.id], keepNames);
      log(`  store cleaned: ${c.deleted} draft theme(s) deleted${c.failed.length ? ', ' + c.failed.length + ' could not be deleted' : ''}`);
      await sleep(delays.afterClean);
    }

    // ---- one theme at a time: install > wait until usable > test > delete > next
    for (let i = 0; i < themeList.length; i++) {
      const t = themeList[i];
      log(`\nTheme ${i + 1} of ${themeList.length}: ${t.name}`);
      if (norm(liveInfo.name) === norm(t.name)) { // it is the published theme: tested where it is, and not deleted
        prog.setPhase('testing', `${t.name} (the live theme)`);
        await record(t, liveInfo.id, Object.assign({}, env, { allowLiveTheme: true }));
        continue;
      }
      prog.setPhase('installing', `Installing ${t.name} (one theme at a time)`);
      const lib = await themesApi.listThemes(ctx, env);
      const known = opts.skipClean ? lib.find((x) => !x.live && x.name && norm(x.name) === norm(t.name)) : null;
      const id = known ? known.id : await install(t, lib, !opts.skipClean);
      if (!id) continue; // install() recorded why
      let usable = { ok: true };
      if (known) log(`  ${t.name}: already in the library (${id})`);
      else usable = await waitUsable(t, id);
      if (usable.ok) {
        prog.setPhase('testing', `Testing ${t.name}`);
        await record(t, id);
      } else {
        run.themes.push({ name: t.name, id, passes: [], setupFailed: { reason: usable.reason, detail: usable.detail } });
        prog.setTheme(t.name, { status: 'failed', step: `${usable.reason}: ${usable.detail}`.slice(0, 160) });
        log(`  ${t.name}: not usable (${usable.reason}: ${usable.detail})`);
        saveRun(runDir, run, checklist, prev);
      }
      if (!opts.keepThemes) { // uninstall it before the next theme is installed
        prog.setPhase('cleaning', `Deleting ${t.name} from the store`);
        const d = await themesApi.deleteTheme(ctx, env, id, dbg);
        log(`  ${t.name}: ${d.ok ? 'deleted from the store' : 'could NOT be deleted (' + d.reason + '), the end-of-run clean-up will try again'}`);
        prog.setTheme(t.name, { step: (d.ok ? 'Tested and deleted from the store' : 'Tested, but could not be deleted') });
        await sleep(delays.afterClean);
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
    require('./lib/browser').markCleanExit(profileDirFor(root, envKey));
    saveRun(runDir, run, checklist, prev);
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
  }
  // ---- end: delete anything that could not be deleted on the way (never the live theme)
  if (outcome === 'completed' && !opts.skipClean && !opts.keepThemes) {
    try {
      prog.setPhase('cleaning', 'Checking that no test theme is left in the store');
      await afterRun(root, cfg, envKey, runDir, log, async (c2, e2) => {
        const c = await themesApi.cleanDrafts(c2, e2, log, dbg, liveInfo ? [liveInfo.id] : [], keepNames);
        log(`  store cleaned at the end: ${c.deleted} draft theme(s) deleted`);
      });
    } catch (e) { log('Final clean-up failed: ' + e.message); }
  }
  prog.setPhase('finishing', 'Writing the report, summary and issue tracker');
  const fin = finalizeRun({ root, cfg, run, checklist, trackIssues: !opts.noTracker, keepAllPictures: !!opts.keepPictures });
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
