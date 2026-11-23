// Browser helpers: a persistent Chrome profile holds the Shopify admin session (no password is ever stored by this tool).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

class LoginRequired extends Error {
  constructor() {
    super('Shopify admin login needed. Run: node src/cli.js login --env <staging|prod>');
    this.name = 'LoginRequired';
  }
}

// One saved login per store and browser: Chrome keeps .profile-<env>, Edge keeps .profile-<env>-msedge.
const profileDirFor = (root, env, browser) => path.join(root, `.profile-${env}${browser === 'msedge' ? '-msedge' : ''}`);
const channelOf = (browser) => (browser === 'msedge' ? 'msedge' : 'chrome');

// Window modes (second argument):
//   'quiet'    (default for runs)  a real Chrome window placed far off-screen: nothing is visible and nothing is raised.
//                                  Pure headless is NOT used by default: Shopify's Cloudflare shows a "Verify you are human" check to it.
//   'headless' no window at all (--headless flag; may hit that robot check)
//   'show'     a normal visible window (login, --show)
// true / false are accepted for older callers: true = 'quiet', false = 'show'.
// When this Chrome is stopped from outside (a stopped run, a killed task), it records "did not shut down correctly". The next
// start then shows the "Restore pages?" bubble and re-opens the old tabs, even moving the off-screen window onto the screen.
// So before every start the profile is set back to "closed normally" and "open a new tab on start".
function markCleanExit(profileDir) {
  for (const rel of [path.join('Default', 'Preferences')]) {
    const f = path.join(profileDir, rel);
    try {
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      j.profile = Object.assign({}, j.profile, { exit_type: 'Normal', exited_cleanly: true });
      j.session = Object.assign({}, j.session, { restore_on_startup: 5 }); // 5 = the new tab page, never the previous tabs
      fs.writeFileSync(f, JSON.stringify(j));
    } catch (e) { /* a profile that cannot be read is left alone */ }
  }
  try { fs.rmSync(path.join(profileDir, 'Default', 'Sessions'), { recursive: true, force: true }); } catch (e) { /* the saved tabs of the last session: not needed */ }
}

async function openAdmin(profileDir, mode, browser) {
  const m = mode === true ? 'quiet' : mode === false ? 'show' : (mode || 'quiet');
  fs.mkdirSync(profileDir, { recursive: true });
  markCleanExit(profileDir);
  const args = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble', '--no-first-run', '--no-default-browser-check', '--disable-infobars'];
  if (m === 'quiet') args.push('--window-position=-2400,-2400', '--window-size=1400,950');
  const ctx = await chromium.launchPersistentContext(profileDir, { channel: channelOf(browser), headless: m === 'headless', viewport: { width: 1400, height: 950 }, args });
  ctx._tcQuiet = m !== 'show';
  return ctx;
}

// One-time manual login (handles the emailed code). Waits until the store admin is reached.
async function loginFlow(profileDir, handle, browser) {
  const ctx = await openAdmin(profileDir, false, browser);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`https://admin.shopify.com/store/${handle}`);
  console.log('A browser window opened. Log in to Shopify there (including the emailed code).');
  console.log('This window closes by itself once the store admin is reached (10 minute limit).');
  await page.waitForURL(new RegExp(`admin\\.shopify\\.com/store/${handle}`), { timeout: 600000 });
  await page.waitForTimeout(4000);
  await ctx.close();
  console.log(`Login saved in ${profileDir}`);
}

// Visible mode only: a minimised window renders nothing (screenshots hang), so restore it and bring the page forward.
async function showWindow(ctx, page) {
  if (ctx._tcQuiet) return; // background modes: never restore or raise a window
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.detach().catch(() => {});
  } catch (e) { /* headless: no window */ }
  await page.bringToFront().catch(() => {});
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const keyOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { chromium, openAdmin, markCleanExit, loginFlow, showWindow, profileDirFor, channelOf, LoginRequired, norm, keyOf, esc };
