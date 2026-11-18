# Where this runs, where the history lives, and whether Cloudflare is needed

Short answer: **the check itself cannot run on Cloudflare, and you do not need Cloudflare to start.** Cloudflare becomes useful later, only to share the dashboard and the pictures with the team.

## What the check needs

| Need | Why it matters for hosting |
|---|---|
| A real Chrome with a saved Shopify admin login | The tool drives the theme editor and the Findter design page. Shopify asks for an emailed code at login, so a person logs in once and the session is kept in `.profile-<env>/`. A fresh cloud machine every run cannot do that. |
| Hours of run time | Estimate (to be confirmed by the first real run): about 8 to 10 minutes per theme (waits for embeds and save, three layouts, mobile, two search passes), so about 8 to 10 hours for 58 themes. |
| Videos and pictures | Failing checks keep pictures and a video of the pass. |

## Options for the runner

| Option | Fits? | Why |
|---|---|---|
| **An always-on Windows PC or VM, Windows Task Scheduler** | **Yes, start here** | Keeps the login, no time limit. The Schedule tab registers the task with one button. Needs the PC on and not asleep at run time. |
| GitHub Actions on a **self-hosted runner** (that same PC) | Yes, optional | Gives a cron, a log page and a manual "Run workflow" button, still on the PC that holds the login. |
| GitHub-hosted Actions runners | No | A job stops after 6 hours, a clean machine every time means no saved login, and a data-center IP is more likely to hit Shopify's robot checks. |
| Cloudflare Workers / Pages Functions | No | Not a place to run a long Chrome session that stays logged in to the Shopify admin. Cloudflare's browser product is meant for short page tasks (check its current limits before relying on it for anything). |

## Where to keep logs, pictures and videos

| What | Size | Where |
|---|---|---|
| `summary.json`, `results.json`, `report.html`, the issue tracker, the run index | small | A **private** GitHub repo, e.g. `Theme_Check_Data`. Set `archive.dir` to a clone of it and `archive.git` to `true`: every finished run is committed there with a message like "Theme check 2026-11-18-staging: 41 failing checks on 22/58 themes". |
| Pictures of failing checks | tens of MB per run (pictures of passing checks are deleted) | Same private repo is fine for a while. |
| Videos | hundreds of MB per run | **Not in git** (GitHub blocks files over 100 MB and large repos get slow). The tool keeps videos only for the newest 4 runs (`archive.keepVideosForRuns`). For longer retention put them in Cloudflare R2 or a shared drive. |

**Do not put history in this repo.** `Theme_Check` is public; `history/` is git-ignored on purpose, because reports contain admin screenshots and store details.

## Where Cloudflare helps (phase 2, when the team needs to look without touching the PC)

1. **Cloudflare Pages**: hosts the read-only dashboard. `node src/cli.js publish` builds `site/` (dashboard, run index, issue tracker, reports and pictures; videos only with `--with-videos`). Deploy with `npx wrangler pages deploy site`.
2. **Cloudflare Access** (Zero Trust): puts a login (the team's emails) in front of the Pages site. Needed, because the reports show the app's compatibility problems and store screenshots. Free for small teams.
3. **R2**: object storage for videos and older pictures. No download fees. Free tier of about 10 GB (check current pricing).

The editing UI (add or remove themes, change the schedule, start a run) stays on the machine that runs the check. It has no login and listens on `127.0.0.1` only, so it must not be exposed. If the team later needs to edit remotely, the options are: edit `config/themes.json` through git, or add a small Pages Functions + KV backend that the runner reads at the start of each run. Not needed now.

## Step-by-step: the Cloudflare monitor

The full guide (R2 bucket, Pages project, token, Access, runner setup, test) is in [CLOUDFLARE.md](CLOUDFLARE.md). Live progress is pushed to it while a run is going, and the finished run's data, reports and pictures are pushed afterwards.

## Recommended plan

1. **Now:** one always-on Windows PC or VM. `node src/cli.js login --env staging` once, `node src/cli.js ui`, set the schedule in the UI and press Apply. Create a private repo for the history and set `archive`.
2. **After two or three real runs:** tune the thresholds with the team, then decide if the team needs the Pages copy.
3. **Only if needed:** Pages + Access (+ R2 for videos).

## Gaps that matter for "runs correctly and completely" (not built yet)

- **Silent failure:** if the Shopify login expires or the PC is off, no run happens and no mail arrives. Add a "no results since N days" alert (a second small scheduled task or a Cloudflare cron that checks the run index and emails).
- **Login lifetime:** the saved session lasts as long as Shopify allows. Plan to run `login` again when a run stops with "login needed".
- **PC power settings:** sleep and automatic restarts will stop a run mid-way. The loop saves after every theme, so a restart can be resumed with `--themes` for the remaining ones, but there is no automatic resume yet.
- **First real run:** the admin steps that are new (editor Preview, Exit, delete theme, compatibility panel) still need one supervised run.
