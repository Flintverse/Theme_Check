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

const profileDirFor = (root, env) => path.join(root, `.profile-${env}`);

// headless = true is the normal mode: Chrome runs with no window at all, so nothing pops up on the screen and no focus is
// taken from what the person is doing. Pass false (the --show flag) only to watch or to log in.
async function openAdmin(profileDir, headless) {
  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1400, height: 950 },
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
  });
  ctx._tcHeadless = !!headless;
  return ctx;
}

// One-time manual login (handles the emailed code). Waits until the store admin is reached.
async function loginFlow(profileDir, handle) {
  const ctx = await openAdmin(profileDir, false);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`https://admin.shopify.com/store/${handle}`);
  console.log('A Chrome window opened. Log in to Shopify there (including the emailed code).');
  console.log('This window closes by itself once the store admin is reached (10 minute limit).');
  await page.waitForURL(new RegExp(`admin\\.shopify\\.com/store/${handle}`), { timeout: 600000 });
  await page.waitForTimeout(4000);
  await ctx.close();
  console.log(`Login saved in ${profileDir}`);
}

// A minimised window renders nothing (screenshots hang): restore it and bring the page forward.
async function showWindow(ctx, page) {
  if (ctx._tcHeadless) return; // background mode: never restore or raise a window
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

module.exports = { chromium, openAdmin, loginFlow, showWindow, profileDirFor, LoginRequired, norm, keyOf, esc };
