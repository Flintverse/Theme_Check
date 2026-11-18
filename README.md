# Theme_Check

Weekly check of Findter (Search & Filter) against Shopify themes. For every theme in `config/themes.json` it:

1. installs the theme in batches of 10 (a store holds at most 20), turns on the two Findter embeds, picks the theme in Findter's Theme list;
2. tests it against the checklist in `checklist/checklist.json` (Vertical, Horizontal, Off-canvas, Mobile, Search desktop and mobile);
3. writes a run-sheet report (`runs/<date>-<env>/report.html`) in the style of the "Watermark Self-test 885" report: one card per checklist item with Steps, Expected, Actual per theme, pictures, and a video for any pass that failed;
4. compares with the previous run (NEW / STILL / FIXED), groups themes that fail for the same reason, and mails the summary through Gmail.

The full human workflow and the checklist reasoning are in [docs/WORKFLOW.md](docs/WORKFLOW.md). Read it first: the tool does exactly those steps (3 tabs: Tab 1 admin design page, Tab 2 theme editor, Tab 3 the editor's Preview).

## Setup

```
npm install
npx playwright-core install ffmpeg      # needed once, for the videos
copy config\config.example.json config\config.local.json   # fill in themeStoreShop and the mail section
node src/cli.js login --env staging     # once: log in to Shopify in the window that opens (emailed code)
```

Nothing secret goes into git: `config.local.json`, `.profile-*/` (saved Shopify sessions) and `runs/` are ignored. The Gmail app password is read from the environment variable `GMAIL_APP_PASSWORD`. Never write passwords into a file or into the workflow document.

## Commands

| Command | What it does |
|---|---|
| `node src/cli.js run --env staging --batches 1` | The weekly loop for batch 1 (10 themes). `--batches 1,2,3` for more, `--themes "Dawn,Craft"` for a hand-picked list, `--skip-clean` to keep the library, `--skip-wait` to skip the 3 minute wait. |
| `node src/cli.js run --env staging --mail` | Same, then mail the result (`--dry-mail` only prints it and writes `mail-preview.html`). |
| `node src/cli.js check --url <storefront url> --name dawn --layouts vertical,offcanvas,mobile,search` | No admin at all: run the checklist on one storefront URL. This is what was used to calibrate the checks. |
| `node src/cli.js report --run 2026-11-18-staging` | Rebuild a report from `results.json`. |
| `node src/cli.js mail --run 2026-11-18-staging [--dry]` | Send (or print) the Gmail summary. |
| `npm test` | Unit tests: the in-page measurements (good and bad layouts) and the report / compare / mail code. |

Scheduling (Windows, the PC must be on): `schtasks /Create /SC WEEKLY /D MON /ST 07:30 /TN "Theme check" /TR "cmd /c cd /d C:\path\Theme_Check && node src/cli.js run --env staging --batches 1,2,3,4,5,6 --mail >> runs\scheduler.log 2>&1"`. The weekly run needs the saved login from `node src/cli.js login`.

## How the checks work

- `src/checks/measure.js` runs inside the page and measures things (is the count on the same line as the value, is the checkbox square, does the icon touch the placeholder, is the hovered count readable, is the X centred in its box...). Selectors come from the app's own storefront code (`.fdt-option-item-count`, `fdt-scroll-to-top`, `.fdt-group-value__toggle`, ...).
- Each result is `pass`, `fail`, `na` (could not be tested here, for example no merged group or no "Choose options" card on this collection) or `review` (a picture is captured for a person to judge, for example slider dots centred).
- `V-10` (a selected value looks selected) compares pictures of the box before and after the click.
- Thresholds (alignment pixels, contrast ratio, width difference) are in `config/config.example.json` under `thresholds`. They are a starting point: tune them with the team using themes where the answer is known.
- The layout on screen is detected and compared with the layout that was set (`G-04`), so a Save that did not take effect cannot silently make every result meaningless.

## Verified and not yet verified

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
config/    themes.json (58 themes in batches of 10), config.example.json
checklist/ checklist.json (id, area, severity, steps, expected, auto|review)
src/       cli.js, batch.js (the loop), admin/ (tabs 1 and 2), checks/ (measure + run), report/, mail.js
test/      unit tests
docs/      WORKFLOW.md
```
