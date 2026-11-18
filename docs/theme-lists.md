# Theme lists: staging and prod

The same list, kept in `config/themes.json` (each theme has `envs`). **Two versions, to cross-check:**

## Prod list: 45 themes (what is really on prod)

Atelier, Colorblock, Craft, Crave, Dawn, Dwell, Fabric, Heritage, Horizon, Origin, Pitch, Publisher, Refresh, Ride, Rise, Ritual, Savor, Sense, Spotlight, Studio, Taste, Tinker, Trade, Vessel, Allure, Be Yours, Broadcast, Concept, Enterprise, Eurus, Expanse, Flawless, Focal, Hyper, Ignite, Impulse, Next, Noom, Pipeline, Sleek, Stiletto, Vivid, Wonder, Xtra, Maximize.

## Staging list: 58 themes (the 45 above plus 13 that exist only on staging)

The 45 prod themes, then: Pebble, Symmetry, Prestige, Release, Palo Alto, Local, Motion, Shapes, Monk, Mono, Impact, Stretch, Warehouse.

## How they are tested

- Each list is tested in batches of 10, in this order (a store holds at most 20 themes): staging = 6 batches (10+10+10+10+10+8), prod = 5 batches (10+10+10+10+5).
- Edit the lists in the dashboard (Themes tab, choose the list; a theme can be on staging, prod, or both). The Themes tab also shows which themes the store library already holds: `node src/cli.js library --env staging`.

## What the staging store held on 2026-11-18 (before the full run)

The Shopify Themes page shows the live theme and only the **5 newest draft themes**, so the library cannot be read in full from that page. What was seen: Horizon (live), and drafts Craft, Dawn (two copies of each, one extra pair created by earlier test runs), Motion, Shapes, Local. So the store did **not** hold the 58 themes: at most 6 of the 58 (Horizon, Craft, Dawn, Motion, Shapes, Local). Because of the 5-draft cap the tool does not rely on "already installed" for a batch: it deletes the draft themes first (never the live theme), installs the batch from the Theme Store, and finds each new theme by name at the top of the list.
