// One compact overview per run: how many errors on how many themes, the worst themes, the most common issues.
const { flatten, compare, groupIssues, totals, FAIL } = require('../report/compare');

function buildSummary(run, checklist, prevRun) {
  const { rows, fixed } = compare(flatten(run), prevRun ? flatten(prevRun) : null);
  const tested = (run.themes || []).filter((t) => !t.setupFailed);
  const setupFailures = (run.themes || []).filter((t) => t.setupFailed).map((t) => ({ theme: t.name, reason: t.setupFailed.reason, detail: t.setupFailed.detail }));
  const fails = rows.filter((r) => FAIL(r.status) && r.id !== 'SETUP');
  const byTheme = new Map();
  fails.forEach((r) => {
    if (!byTheme.has(r.theme)) byTheme.set(r.theme, { theme: r.theme, fails: 0, ids: new Set() });
    const e = byTheme.get(r.theme);
    e.fails += 1;
    e.ids.add(r.id);
  });
  const issues = groupIssues(rows.filter((r) => r.id !== 'SETUP'), checklist);
  const themesWithIssues = new Set(fails.map((r) => r.theme));
  return {
    runId: run.runId,
    env: run.env,
    date: String(run.startedAt).slice(0, 10),
    startedAt: run.startedAt,
    comparedWith: prevRun ? prevRun.runId : null,
    themesTotal: (run.themes || []).length,
    themesTested: tested.length,
    themesWithIssues: themesWithIssues.size,
    themesClean: tested.filter((t) => !themesWithIssues.has(t.name)).length,
    failedChecks: fails.length,
    issueTypes: issues.length,
    totals: totals(rows),
    newCount: rows.filter((r) => r.change === 'NEW').length,
    stillCount: rows.filter((r) => r.change === 'STILL').length,
    fixedCount: fixed.length,
    fixed: fixed.map((r) => ({ theme: r.theme, layout: r.layout, id: r.id })),
    worstThemes: Array.from(byTheme.values()).map((e) => ({ theme: e.theme, fails: e.fails, checks: Array.from(e.ids) })).sort((a, b) => b.fails - a.fails).slice(0, 10),
    topChecks: issues.slice().sort((a, b) => b.themes.length - a.themes.length).slice(0, 10).map((i) => ({ id: i.id, title: i.title, severity: i.severity, themes: i.themes.length })),
    setupFailures,
  };
}

module.exports = { buildSummary };
