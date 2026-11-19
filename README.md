# Listings Atlas

Public dashboard for merged car listings from Willhaben, AutoScout24, Kleinanzeigen, and coches.net.

**Site:** https://crangoone.github.io/listings-atlas-/

GitHub Pages serves this repository from branch `main` at the repository root. The site is static HTML, CSS, and JavaScript, plus JSON boards. Marketplace scrapers and the SQLite car library stay in the private Cursor repo. This repo hosts the Pages site and the queue files that ask that repo to launch a crawl wave or rebuild the library.

The copy in the private Cursor repo is `docs/README.md`. Publish it with the rest of the Pages tree (`python3 daq/jobs/publish_atlas_assets.py`).

## Panels

### Insights

Market overview: listing counts, price bands, top makes, and per-source fill rates. Charts read `data/summary.json` and `data/sources_summary.json`. No database connection is required. **Refresh** reloads those files.

### Library

Search individual listings.

1. **Connect** to the query API at `https://listings-atlas-query.fly.dev` with the Atlas query key. The key stays in this browser. The API returns matching rows as JSON.
2. **Load local .db** with a copy of `car_library.db`. The page runs the query in the browser through sql.js, including offline.

Set make, model, and any extra filters, or open **Decode VIN** for a 17-character VIN (European local type codes plus NHTSA) and similar comps. Then **Show results**. Open a row for the full record and the listing link.

### Crawls

Status of crawl workers (queued, running, finished, failed, cancelled), with makes, row counts, and agent or pull-request links when the board has them.

**Launch all sources** writes `data/pending_wave.json`. **Stale only** skips keys crawled inside the fresh-hours window (default 168 hours). **Update listings** writes `data/pending_consolidate.json`. A push of either file runs **Forward Atlas automation requests**, which posts the queue to the Cursor automation. Under **Automation credentials**, a listings-atlas- contents token (and optional webhook URL and bearer) can be saved on this device. Those values are not committed.

## Layout

| Path | Role |
|------|------|
| `index.html` | Insights, Library, and Crawls |
| `assets/` | Dashboard, library search, VIN decode, crawl board, source logos |
| `data/summary.json` | Pack KPIs for Insights |
| `data/sources_summary.json` | Per-source quality and last crawl |
| `data/crawl_jobs.json` | Job catalog used by the Crawls panel |
| `data/crawl_status.json` | Live worker board |
| `data/crawl_status.schema.json` | Shape of `crawl_status.json` |
| `data/pending_wave.json` | Queued crawl wave (`kind`: `listings-atlas-crawl-wave`) |
| `data/pending_consolidate.json` | Queued library rebuild (`kind`: `listings-atlas-consolidate`) |
| `.github/workflows/forward-atlas-webhooks.yml` | Forwards the two queue files to Cursor on push |
| `.nojekyll` | Pages serves the files as committed |

## How files get here

From the private Cursor repo:

- UI, logos, KPIs, and `data/crawl_jobs.json` — `python3 daq/jobs/publish_atlas_assets.py` (source tree: `docs/`)
- Crawl board — `python3 daq/jobs/publish_crawl_status.py`

Pages usually refreshes within about a minute. After **Update listings**, the car library is refreshed on the query host. The `.db` file is not committed to this repo.

Scraper commands, consolidation, and the query-host deploy live next to the jobs catalog in the private repo (`daq/jobs/README.md`, `daq/QUERY.md`, `daq/FLY_QUERY.md`).

## Local preview

Serve this directory with any static file server and open the site root. Insights and Crawls load the JSON beside the page. Library still needs the query API or a local `car_library.db`. In the private Cursor checkout the same tree is `docs/`.
