# NYC Accessibility Scan POC

A small open-source scanner + dashboard that runs [axe-core](https://github.com/dequelabs/axe-core) against a list of NYC agency homepages and renders a tiered scorecard. Built as an internal proof-of-concept at NYC OTI to inform a build-vs-buy decision on accessibility-scanning vendors (Deque Axe Monitor, Evinced, Siteimprove).

**This is a floor check, not a certification.** Automated tools catch ~30–57% of WCAG issues. The remaining ~50% — meaningful alt text, sensible focus order, screen-reader operability, cognitive clarity — requires manual review.

## What it does

- Scans every URL in `sites.json` with axe-core (the same engine every commercial tool wraps), filtered to **WCAG 2.2 AA** (the [NYC Digital Design System](https://www.nyc.gov/site/oti/services/nyc-digital-design-system.page) standard, ahead of the federal Title II rule which is still 2.1 AA).
- Tiers each site **red / yellow / green** by max violation severity.
- Writes a static dashboard (`dashboard/index.html`) that needs no server to view — just open the file. Three views: overview → per-site → per-rule (expandable to show the offending DOM nodes and a link to Deque's remediation docs).

## Setup

Requires Node 20+. `npm install` will pull in Puppeteer, which downloads its own bundled Chromium (~170 MB) — no system Chrome needed.

```bash
npm install
```

## Run a scan

```bash
npm run scan                  # scan everything in sites.json
node scan.js --only=OTI       # scan a single site (smoke test)
```

This writes:

- `dashboard/results.js` — consumed by the dashboard
- `results.json` — same data, for piping into other tools

## View the dashboard

```bash
npm run dashboard             # serves dashboard/ at http://localhost:3000
# or just:
open dashboard/index.html
```

Both work — the dashboard loads its data via `<script src="results.js">` rather than `fetch()`, so it works on `file://` without a local server.

## Run the engine sanity check

```bash
npm test
```

Scans `test-fixtures/broken.html` (a deliberately broken page) and asserts that axe catches the obvious violations — `image-alt`, `button-name`, `link-name`, `label`, `color-contrast`, `html-has-lang`. Useful for confirming the engine is wired up correctly after dependency upgrades.

## Editing the site list

`sites.json` is a flat array of `{ name, url }`. Note that NYC currently runs two CMS schemes side-by-side:

- New CMS: `https://www.nyc.gov/content/<agency>/pages/home`
- Old CMS: `https://www.nyc.gov/site/<agency>/index.page`

Different agencies have migrated at different times; if you get a `HTTP 404` during a scan, try the other scheme.

## What this POC explicitly does not do

These are the things commercial products charge for. Calling them out so the build-vs-buy comparison stays honest:

| Feature | This POC | Axe Monitor / Evinced / Siteimprove |
|---|---|---|
| Same axe-core engine | ✓ | ✓ |
| WCAG 2.2 AA filtering | ✓ | ✓ |
| Per-rule clustering, DOM selectors | ✓ | ✓ |
| Crawling beyond homepage | ✗ | ✓ |
| Authenticated page scanning | ✗ | ✓ |
| Historical trending / regression detection | ✗ | ✓ |
| Hosted multi-user dashboard with auth | ✗ | ✓ |
| Ticket integration (Jira, etc.) | ✗ | ✓ |
| Scheduled scans | ✗ (cron it yourself) | ✓ |

A v2 of this could realistically pick up crawling (lift `pa11y-ci`'s sitemap mode), a SQLite-backed history table, and a GitHub Actions cron — that's ~a week of work, not a license fee.

## Project layout

```
accessibility-nyc/
├── scan.js                    # the scanner
├── sites.json                 # editable URL list
├── results.json               # scanner output (also written as dashboard/results.js)
├── dashboard/
│   ├── index.html             # entry
│   ├── app.js                 # renders SCAN_DATA into overview + detail views
│   ├── styles.css             # ~150 lines on top of Pico.css
│   └── results.js             # generated; window.SCAN_DATA = {...}
├── test/
│   └── check-engine.js        # sanity test against the broken fixture
├── test-fixtures/
│   └── broken.html            # deliberately broken page for the sanity test
└── package.json
```

## Engine reference

- [axe-core](https://github.com/dequelabs/axe-core) — MPL-2.0
- [@axe-core/puppeteer](https://www.npmjs.com/package/@axe-core/puppeteer) — Mozilla Public License 2.0
- Each violation links to `https://dequeuniversity.com/rules/axe/...` for remediation guidance, courtesy of Deque.
