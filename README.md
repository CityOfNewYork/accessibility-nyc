# NYC Accessibility Scanner

An open-source scanner and dashboard that runs [axe-core](https://github.com/dequelabs/axe-core) against a list of NYC agency websites and renders a tiered scorecard.

**Live dashboard: <https://cityofnewyork.github.io/accessibility-nyc/>** — published from this repo, refreshed with every scan commit.

**This is a floor check, not a certification.** Automated tools catch ~30–57% of WCAG issues. The remaining ~50% — meaningful alt text, sensible focus order, screen-reader operability, cognitive clarity — requires manual review and assistive-technology testing.

## What it does

- Scans every URL in `sites.json` with axe-core, filtered to **WCAG 2.2 AA** — the standard required of City agencies by Local Law 26 of 2016 and adopted as the current version in the 2025 NYC Digital Accessibility Report from OTI and MOPD.
- Tiers each site **red / orange / yellow / green** by max violation severity (orange = serious issues remain but every critical issue is resolved).
- Crawls multi-page sites breadth-first (per-site `crawl: true` flag), skipping links to PDFs and other non-HTML files; drives single-page apps through their real interaction states (`scan-finders.mjs`); scans fixed page lists (per-site `pages: [...]`) for curated sets that span sites, like the Golden Set.
- Writes a static dashboard (`dashboard/index.html`) that needs no server to view — just open the file. Views: overview → per-site → per-page, with findings groupable **by rule, by component, or by page**, and search across pages, sites, and rules.

## Setup

Requires Node 20+. `npm install` will pull in Puppeteer, which downloads its own bundled Chromium (~170 MB) — no system Chrome needed.

```bash
npm install
```

## Run a scan

```bash
npm run scan                  # scan everything in sites.json
node scan.js --only=OTI       # scan a single site (smoke test)
node scan.js --max-pages=150  # lower the per-site crawl cap (default 1000)
```

This writes:

- `dashboard/results.js` — consumed by the dashboard
- `results.json` — same data, for piping into other tools

Each page record also carries axe's `incomplete` ("needs review") results in slimmed form — captured because they can't be backfilled later, but never counted toward tiers, totals, or history.

## View the dashboard

```bash
python3 serve.py 3000         # dependency-free local server (sends no-store headers, so refresh always shows latest)
npm run dashboard             # same thing via npx serve — needs npm registry access
# or just:
open dashboard/index.html
```

All three work — the dashboard loads its data via `<script src="results.js">` rather than `fetch()`, so it works on `file://` without a local server.

## Run the engine sanity check

```bash
npm test
```

Scans `test-fixtures/broken.html` (a deliberately broken page) and asserts that axe catches the obvious violations — `image-alt`, `button-name`, `link-name`, `label`, `color-contrast`, `html-has-lang`. Useful for confirming the engine is wired up correctly after dependency upgrades.

## Editing the site list

`sites.json` is a flat array of `{ name, url, crawl?, pathPrefix?, app?, pages? }`:

- `crawl: true` — breadth-first crawl from `url`, scoped by `pathPrefix`
- `app: true` — interaction-driven scan via `scan-finders.mjs` (form-gated/SPA finders that can't be link-crawled)
- `pages: [url, …]` — scan exactly these URLs, no crawl (used for curated cross-site sets like the Golden Set)

Note that NYC currently runs three CMS schemes side-by-side:

- New CMS: `https://www.nyc.gov/content/<agency>/pages/home`
- Old CMS: `https://www.nyc.gov/site/<agency>/index.page`
- Legacy: `https://www.nyc.gov/html/<agency>/...` (e.g. DOT)

Different agencies have migrated at different times; if you get a `HTTP 404` during a scan, try another scheme.

## Project layout

```
accessibility-nyc/
├── scan.js                    # link-crawl scanner
├── scan-finders.mjs           # interaction-driven scanner for app-style sites
├── sites.json                 # editable URL list
├── results.json               # scanner output (also written as dashboard/results.js)
├── dashboard/
│   ├── index.html             # entry
│   ├── app.js                 # overview / per-site / per-page views + search
│   ├── styles.css
│   └── results.js             # generated; window.SCAN_DATA = {...}
├── test/
│   └── check-engine.js
├── test-fixtures/
│   └── broken.html
└── package.json
```

## Engine reference

- [axe-core](https://github.com/dequelabs/axe-core) — MPL-2.0
- [@axe-core/puppeteer](https://www.npmjs.com/package/@axe-core/puppeteer) — MPL-2.0
- Each violation links to `https://dequeuniversity.com/rules/axe/...` for remediation guidance.
