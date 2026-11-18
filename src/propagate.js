// "Save once, everything follows": after the schedule or the theme lists change, bring every place in line:
//   1. the Windows scheduled task (daily / weekly / every N days)            2. Cloudflare (the page and the saved configuration)
//   3. GitHub (config/schedule.json and config/themes.json are committed and pushed)
// Each step reports ok / failed on its own, so one failing step never hides the others. Steps are injectable for tests.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sched = require('./schedule');
const cfgLib = require('./config');
const sync = require('./sync');
const { buildState } = require('./publish');

const TRACKED = ['config/schedule.json', 'config/themes.json'];

function git(root, args) {
  const r = spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8' });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

// Commit only the two config files (never anything else in the working tree) as an automatic author, then push.
function gitCommitPush(root, message) {
  if (!fs.existsSync(path.join(root, '.git'))) return { ok: false, detail: 'this folder is not a git repository' };
  const files = TRACKED.filter((f) => fs.existsSync(path.join(root, f)));
  git(root, ['add', '--'].concat(files));
  if (git(root, ['diff', '--cached', '--quiet', '--'].concat(files)).ok) return { ok: true, detail: 'nothing changed in the repository' };
  const commit = git(root, ['-c', 'user.name=Theme Check', '-c', 'user.email=theme-check@users.noreply.github.com', 'commit', '-m', message, '--'].concat(files));
  if (!commit.ok) return { ok: false, detail: 'commit failed: ' + commit.out.slice(0, 160) };
  let push = git(root, ['push']);
  if (!push.ok) { git(root, ['pull', '--rebase', '--autostash']); push = git(root, ['push']); }
  return push.ok ? { ok: true, detail: 'committed and pushed to GitHub' } : { ok: false, detail: 'committed locally, push failed: ' + push.out.slice(0, 160) };
}

const step = (name, ok, detail) => ({ step: name, ok, detail: detail || '' });

// what: { schedule: bool, themes: bool }. who: text for the commit message. cloudConfig: send the saved configuration to
// Cloudflare (false when the change CAME from Cloudflare). Returns the list of steps.
async function propagate(root, cfg, what, who, opts) {
  const o = Object.assign({ cloudConfig: true, applySchedule: sched.applySchedule, gitCommitPush, fetchImpl: null }, opts || {});
  const steps = [step('Saved on the test machine', true)];

  if (what.schedule) {
    try {
      const s = sched.loadSchedule(root);
      const r = o.applySchedule(s, root, Object.keys(cfg.envs));
      steps.push(step('Windows Task Scheduler', !!r.ok, r.ok ? (r.message || sched.describe(s)) : (r.error || 'failed')));
    } catch (e) { steps.push(step('Windows Task Scheduler', false, e.message)); }
  }

  const monitor = sync.syncConfig(cfg);
  if (!monitor) steps.push(step('Cloudflare', true, 'not configured here, skipped'));
  else if (monitor.error) steps.push(step('Cloudflare', false, monitor.error));
  else {
    try {
      if (o.cloudConfig) {
        const body = { rev: Date.now(), updatedBy: who || 'test machine', schedule: sched.loadSchedule(root), themes: cfgLib.loadThemes(root) };
        await sync.send(monitor, 'POST', 'config', JSON.stringify(body), null, o.fetchImpl);
      }
      await sync.pushState(monitor, buildState(root, cfg, { remote: true }), o.fetchImpl);
      steps.push(step('Cloudflare', true, 'the web page now shows the new settings'));
    } catch (e) { steps.push(step('Cloudflare', false, e.message)); }
  }

  try {
    const parts = [what.schedule ? 'schedule' : null, what.themes ? 'theme lists' : null].filter(Boolean).join(' and ');
    const g = o.gitCommitPush(root, `Config: ${parts} changed by ${who || 'the test machine'}`);
    steps.push(step('GitHub', !!g.ok, g.detail));
  } catch (e) { steps.push(step('GitHub', false, e.message)); }
  return steps;
}

module.exports = { propagate, gitCommitPush, TRACKED };
