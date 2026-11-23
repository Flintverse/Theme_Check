# Theme_Check

Weekly check of Findter (Search & Filter) against Shopify themes. For every theme in `config/themes.json` it:

1. installs the theme in batches of 10 (a store holds at most 20), turns on the two Findter embeds, picks the theme in Findter's Theme list;
2. tests it against the checklist in `checklist/checklist.json` (Vertical, Horizontal, Off-canvas, Mobile, Search desktop and mobile);
3. writes a run-sheet report (`runs/<date>-<env>/report.html`) in the style of the "Watermark Self-test 885" report: one card per checklist item with Steps, Expected, Actual per theme, and a screenshot of each failing check taken at that moment (no video);
4. compares with the previous run (NEW / STILL / FIXED), groups themes that fail for the same reason, and mails the summary through Gmail.

The full human workflow and the checklist reasoning are in [docs/WORKFLOW.md](docs/WORKFLOW.md). Read it first: the tool does exactly those steps (3 tabs: Tab 1 admin design page, Tab 2 theme editor, Tab 3 the editor's Preview).

## Setup

```
npm install
copy config\config.example.json config\config.local.json   # fill in themeStoreShop and the mail section
node src/cli.js login --env staging     # once: log in to Shopify in the window that opens (emailed code)
```

Nothing secret goes into git: `config.local.json`, `.profile-*/` (saved Shopify sessions) and `runs/` are ignored. The Gmail app password is read from the environment variable `GMAIL_APP_PASSWORD`. Never write passwords into a file or into the workflow document.

## Commands

| Command | What it does |
|---|---|
| `node src/cli.js run --env staging --batches 1` | The weekly loop (runs **in the background**: Chrome has no window and takes no focus; add `--show` to watch it) for batch 1 (10 themes). `--batches 1,2,3` for more, `--themes "Dawn,Craft"` for a hand-picked list, `--skip-clean` to keep the library, `--skip-wait` to skip the 3 minute wait. |
| `node src/cli.js run --env staging --mail` | Same, then mail the result (`--dry-mail` only prints it and writes `mail-preview.html`). |
| `node src/cli.js check --url <storefront url> --name dawn --layouts vertical,offcanvas,mobile,search` | No admin at all: run the checklist on one storefront URL. This is what was used to calibrate the checks. |
| `node src/cli.js report --run 2026-11-18-staging` | Rebuild a report from `results.json`. |
| `node src/cli.js mail --run 2026-11-18-staging [--dry]` | Send (or print) the Gmail summary. |
| `node src/cli.js sync [--run <id>] [--all]` / `watch` | Push the dashboard data, reports and pictures to the Cloudflare monitor (Pages + R2) / keep pushing the live progress of a run. See [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) and [docs/GITHUB.md](docs/GITHUB.md). |
| `node src/cli.js ui [--port 4173]` | **The dashboard** on `http://127.0.0.1:4173` (this machine only): **Live** (progress of the run in progress, theme by theme), Overview (numbers for the latest run, worst themes, most common issues, trend), Issue tracker, Runs, Themes (add / remove / enable / batch), Schedule (daily, weekly or every N days, Apply to Windows Task Scheduler, Run now). |
| `node src/cli.js publish [--out site]` | Builds a **read-only** copy of the dashboard in `site/` for a static host (see docs/DEPLOYMENT.md). |
| `npm test` | Unit tests: the in-page measurements (good and bad layouts) and the report / compare / mail code. |

**Run test** (dashboard tab, web copy for editors and local): choose themes from the store's list, a store (environment) and a browser (Chrome or Edge), press **Run test**. The request goes to Cloudflare (`data/run-requests/<id>.json`); the agent takes it within about 15 seconds, checks it again, and starts `node src/cli.js run --env <store> --themes "<names>" --browser <browser> --label manual-HHMMSS --keep-pictures --no-tracker` as its own detached process with its own browser, so it does not touch a run already going. The rules (`src/run-queue.js`):
- **One run per store at a time.** The Findter layout is a store-wide setting and a run installs and deletes themes in the store, so two runs in one store would change each other's result. A request for a busy store waits (`queued`) and starts by itself when that run ends; a request for a free store starts at once, in parallel with runs in other stores. A run in progress is never stopped by a request; only a request that has not started can be cancelled.
- A store and browser need a saved login on the test machine (`.profile-<store>` for Chrome, `.profile-<store>-msedge` for Edge): `node src/cli.js login --env <store> [--browser msedge]`. Without it the request is `rejected` with that command.
- The live progress is one file per store (`history/data/progress-<store>.json`, Cloudflare `data/progress-<store>.json`), so two runs do not overwrite each other. The Live page shows a switch between the stores that have a run.
- By default a hand-picked test does not touch the issue tracker (tick "Add to the issue tracker" to include it).
- From the command line: `node src/cli.js queue --env prod --themes "Dawn,Craft" [--browser msedge]`, and `node src/cli.js queue --list`. The local dashboard (`node src/cli.js ui`) has the same tab.

Save once, everything follows: when someone on the list `EDITORS` (wrangler.toml) saves the schedule or the theme list on the web page, or you save it in the local dashboard, the change is written to `config/schedule.json` / `config/themes.json`, applied to Windows Task Scheduler, sent to Cloudflare, and committed and pushed to GitHub (only those two files, author "Theme Check"). The page then shows each step with ok / failed. For changes made on the web page the hidden **agent** on the test machine does this (it checks Cloudflare every minute): install it once with `node src/cli.js agent --install` (Windows task "Theme check agent", starts at logon, no window; `--uninstall` removes it).

Manual verdicts: in the Live page, click a theme and tick **Skip / Pass / Review / Fail** on any check row (untick to go back to what the script found). The script's own result is never changed (`results.json`); the verdicts are in `history/runs/<run>/overrides.json`, and the report, the numbers, the run overview and the issue tracker follow them. Only editors can tick on the web copy; the local dashboard can always. The agent keeps the web copy and this machine in step (the higher `rev` wins).

User guide for the team: `ui/guide.html` (the **Guide** link in the dashboard menu). Short, step by step, with pictures; the pictures are made by `node tools/guide-shots.js` from demo data (run it when no test run is going).

Navigation: every page has a way back and a way to every other page. The dashboard has a **Back** button, breadcrumbs and the tabs on every page; a theme opened from Live is in the address (`#live/<theme>`), so the browser's Back closes it and a link to it can be shared; the drawer has Back to Live, Previous / Next theme and links to every tab (and to the Issue tracker filtered to that theme). The full report has a bar with links to every page of the tool. Pages are `#live`, `#overview`, `#issues`, `#runs`, `#themes`, `#schedule`.

All times in the logs, reports, mail and dashboard are **UTC+7**; a run belongs to its UTC+7 day. Stored timestamps stay in UTC. Task Scheduler runs at the PC's clock, so the PC must be set to UTC+7.

Scheduling: set it in the dashboard (Schedule tab: daily, weekly, or every N days) and press Save; it registers the Windows task "Theme check". The PC must be on, and the login from `node src/cli.js login` must still be valid. The top of the Schedule tab shows, live (web copy and local): whether automatic runs are On, whether the Windows task is registered, the **next run** (with a countdown) and the **last run** with its result, which store/batches/mail the registered task will really run (a mismatch with the saved settings is named, with what to press), what is **running now** (store, themes done, current step, link to Live) and what is **queued**. Buttons: **Edit the schedule**, **Turn off** (removes the Windows task and saves the schedule as Off, keeping the settings), **Run a test now**. The agent pushes these facts (`schedule-info`) about every 20 seconds while they change; the web page says when the test machine has not reported for 3 minutes.

Speed (per theme about 7½-8 min wall clock, about 5 min in the Time column): a setup step is **proved** (a button changes, Save greys out, the theme shows in the list, Findter shows on the storefront) and then given a short pause, instead of long fixed waits (`DELAYS` in `src/batch.js`). If the quick first attempt does not end with Findter on the storefront, the editor setup is repeated once with the long pauses (`SLOW`), so a slow Shopify costs a few minutes, not a failure. The editor is opened once (tried up to 3 times), the read-back after the Save runs at the same time as the storefront check, and the store-wide layout is not reset between themes: odd themes go Vertical > Horizontal > Off-canvas, the next one starts where that ended and goes back (two layout switches per theme instead of four; the run puts the layout back to Vertical at its end). `results.json` has `setup.timings` (seconds since the theme started, per milestone) and every check has `sec`, so where time goes can be read from the data.

## History: where everything is kept

Every finished run is stored in `history/` (git-ignored). To share it, set `archive.dir` to a clone of a **private** repo and `archive.git` to `true`, and each run is committed there.

```
history/runs/<date>-<env>/   report.html, results.json, summary.json, pictures of the failing checks
history/data/runs.json       one overview line per run (date, themes with issues, failing checks, new, fixed, worst themes)
history/data/issues.json     the issue tracker: for each theme + layout + check that ever failed: first seen, last seen failing,
                             the check date that confirmed it fixed, reopened count, and a pass/fail dot for every later check
```

Pictures of passing checks are deleted after a run; there is no video, only a screenshot taken at the moment of each failing check. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for where to run this, where to keep history, and what Cloudflare is (and is not) for.

## How the checks work

- `src/checks/measure.js` runs inside the page and measures things (is the count on the same line as the value, is the checkbox square, does the icon touch the placeholder, is the hovered count readable, is the X centred in its box...). Selectors come from the app's own storefront code (`.fdt-option-item-count`, `fdt-scroll-to-top`, `.fdt-group-value__toggle`, ...).
- Each result is `pass`, `fail`, `na` (could not be tested here, for example no merged group or no "Choose options" card on this collection) or `review` (a picture is captured for a person to judge, for example slider dots centred).
- `V-10` (a selected value looks selected) compares pictures of the box before and after the click.
- Thresholds (alignment pixels, contrast ratio, width difference) are in `config/config.example.json` under `thresholds`. They are a starting point: tune them with the team using themes where the answer is known.
- The layout on screen is detected and compared with the layout that was set (`G-04`), so a Save that did not take effect cannot silently make every result meaningless.

## Verified and not yet verified

Verified for the dashboard, history and schedule: 30 automated tests, including the dashboard rendered in Chrome with seeded runs, the issue tracker going open, fixed and reopened, and the read-only published copy. Not yet done: registering the real Windows task (the arguments are tested, the call to the scheduler is not run in tests), a run started from the UI, and pushing history to a private repo.

Verified (run against the owner's research store, anonymous preview URLs, and the unit tests):
- the storefront passes and all measurements on Colorblock (passes, as the team found) and Allure (reproduces the known bugs: magnifier overlapping the placeholder, scroll-to-top button with no arrow, search bar not usable);
- report, comparison, grouping and the mail text (dry run). Gmail sending itself needs `GMAIL_APP_PASSWORD` and has not been sent yet.

Ported from the earlier theme-canary tool, which worked, but **not run end to end in this repo**: login, Findter design page layout switch, theme install, embed switching, Theme list choice, Save.

**New and never run against the real Shopify admin. They need a calibration run with the owner present (the login asks for an emailed code):**
- `getPreviewUrl` (editor "..." > Preview); until calibrated it falls back to the `preview_theme_id` URL and the report says which one was used;
- `exitEditor` (Exit icon);
- `deleteTheme` (theme card menu > Delete) and the "clean the store" step that uses it;
- the checks of the `Compatibility issue` panel in the editor (`P-01`);
- `V-09`/`M-04` ("Choose options") and `V-11` (selected chips) on a collection that has those elements; they report `na` where the collection has none.

Keep this list honest: when a step has been run for real, move it up.

## Layout

```
config/    themes.json (58 themes in batches of 10, on/off), config.example.json, schedule.json (created by the UI)
ui/        index.html (the dashboard)
checklist/ checklist.json (id, area, severity, steps, expected, auto|review)
src/       cli.js, batch.js (the loop), admin/ (tabs 1 and 2), checks/ (measure + run), report/, mail.js,
           store/ (summary, issue tracker, archive), schedule.js, server.js (dashboard), publish.js
test/      unit tests
docs/      WORKFLOW.md
```
