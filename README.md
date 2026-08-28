# NYC Accessibility Scanner

An open-source scanner and dashboard that runs [axe-core](https://github.com/dequelabs/axe-core) against a list of NYC agency websites and renders a tiered scorecard.

**Live dashboard: <https://cityofnewyork.github.io/accessibility-nyc/>** — published from this repo, refreshed with every scan commit.

**This is a floor check, not a certification.** Automated tools catch ~30–40% of WCAG issues. Meaningful alt text, focus order, and screen-reader operability require manual testing and human judgement.

## What it does

- Scans every URL in `sites.json` with axe-core, filtered to **WCAG 2.2 AA** — the standard required of City agencies by Local Law 26 of 2016 and adopted as the current version in the 2025 NYC Digital Accessibility Report from OTI and MOPD.
- Scans each page at **two viewports** — desktop (1280×900) and mobile (390×844) — because mobile-breakpoint DOM (hamburger menus, collapsed nav) never renders in a desktop-only scan and rules like `target-size` are viewport-sensitive. Findings present at both widths are deduplicated; findings only the mobile pass can see are tagged and badged "mobile only" in the dashboard (`--no-mobile` skips the second pass).
- Tiers each site **red / orange / yellow / green** by max violation severity (orange = serious issues remain but every critical issue is resolved).
- **Settles lazy-loaded content before scanning** — step-scrolls each page to the bottom and back so content below the fold has actually loaded. Without this, placeholder markup is scanned in its pre-load state and produces findings no real user ever meets (`--no-settle` reproduces the old behavior).
- **Reports third-party YouTube embed findings without counting them** — see [Third-party embeds](#third-party-embeds) below.
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
node scan.js --no-mobile      # desktop pass only (matches pre-mobile scan output)
node scan.js --no-settle      # skip the lazy-load scroll pass (matches pre-settle output)
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

Runs five checks: `test/check-core-shared.js` fails the build if either scanner defines its own copy of a scoring rule instead of importing it from `scan-core.mjs` (see [Shared scoring rules](#shared-scoring-rules)), `test/check-merge.js` unit-tests the desktop/mobile viewport dedup (`mergeViewportViolations`), `test/check-embeds.js` unit-tests the third-party embed exclusion (findings inside a YouTube frame are never counted; findings on the `<iframe>` tag itself always are), `test/check-suppressions.js` unit-tests the verified-false-positive rules (required justification, mandatory expiry, narrow matching, fatal on a malformed file), and `test/check-engine.js` scans `test-fixtures/broken.html` (a deliberately broken page) asserting that axe catches the obvious violations — `image-alt`, `button-name`, `link-name`, `label`, `color-contrast`, `html-has-lang`. Useful for confirming the engine is wired up correctly after dependency upgrades.

## Shared scoring rules

There are two scanners — `scan.js` (link crawler) and `scan-finders.mjs` (interaction-driven, for form-gated and SPA finder apps). They discover pages very differently, but once a page is loaded they must **measure it identically**: the dashboard merges their output into one `results.json` and one scorecard, so a tier has to mean the same thing whichever tool produced it.

Everything that decides what counts, what a tier means, or what reaches history lives in **`scan-core.mjs`** and nowhere else — tiering, impact counting, embed tagging, page settling, slimming, and history rule-building. Both scanners import it.

This is enforced, not remembered. `test/check-core-shared.js` fails the build if either scanner declares its own copy of a shared name. The previous mechanism was a comment reading "mirror scan.js — keep in sync", and it did not work: `scan-finders.mjs` had redefined `tierFor` so that serious-without-critical graded **red**, while `scan.js` graded the same counts **orange**.

If you add a scoring helper, put it in `scan-core.mjs` and add its name to the `SHARED` list in that test.

## Third-party embeds

Some findings come from inside an embedded third-party widget — the agency's page contains an `<iframe>`, and the violation is in markup the vendor ships, not markup the agency wrote or can edit.

**YouTube findings are reported but not counted.** They appear in a collapsed "Third-party embeds — not counted toward score" section on the site and page views, and any page carrying a YouTube embed shows a grey advisory. They are excluded from tiers, counts, totals, and the trend chart.

This is a deliberate case-by-case allowlist (`EXCLUDED_EMBEDS` in `scan.js`), not a blanket "ignore cross-origin iframes" rule. YouTube qualifies because:

- It is ubiquitous across nyc.gov.
- Its player markup churns week to week under us. Across six consecutive weekly scans of one page carrying a single YouTube embed, the finding set changed four times — including dropping to zero on 2026-07-24 and returning to three findings on 2026-07-31. The findings track the player's release train, not the page.
- The findings are not actionable by the embedding agency.
- A video's content is normally also on the page in another form, which is what the advisory asks agencies to confirm.

**Every other embed still counts.** Tableau, Facebook, Maps and the rest stay in the score on purpose: an agency may not realize an embedded dashboard carries issues, and unlike a video those can gate content that exists nowhere else on the page.

**Findings on the `<iframe>` tag itself always count**, whatever the vendor. `frame-title` — a missing `title` attribute on the embed — is the agency's own markup and its own fix. The exclusion suppresses the vendor's mistakes, not the agency's mistakes about the vendor.

### Reading the trend across this change

Both the lazy-load settling and the embed exclusion landed in the same scan, and they push counts in opposite directions: settling finds **more** (lazy-loaded content is now scanned at all), exclusion counts **fewer**. History entries from this point carry `settled: true` and `excludedEmbeds: ["YouTube"]` so the chart can mark where the methodology changed — the same way `viewports` marks the mobile-scan cutover. A step in the trend at that date is a tool change, not a site change.

## Verified false positives (`suppressions.json`)

Sometimes axe reports a failure that isn't one. `suppressions.json` records findings a human checked and determined are wrong. This is a different thing from the embed allowlist above: that says *"this vendor's markup isn't the agency's problem"*; a suppression says *"this specific finding is not true."* So it is scoped tightly and it expires.

The file is an array; a missing file means no suppressions. A **malformed file fails the scan** rather than being skipped — a suppression that silently fails to load leaves numbers that still look plausible.

```json
[
  {
    "site": "Summer",
    "page": "https://www.nyc.gov/content/summer/pages/",
    "rule": "color-contrast",
    "selector": ".hero-banner h1",
    "reason": "Verified false positive: axe computes contrast against the fallback background because the hero image paints over it. Measured 7.1:1 against the actual painted background.",
    "verified_on": "2026-08-20",
    "expires": "2027-02-20"
  }
]
```

Every field above is required. Use `pagePattern` instead of `page` for templated pages that repeat one false positive — `"pagePattern": "https://www.nyc.gov/content/summer/*"`, where only `*` is special. Set one or the other, never both.

Four rules the implementation enforces:

- **Suppressed is not deleted.** The finding stays in `results.json` and renders in a "Verified false positives" section with its reason attached. Anyone running axe themselves will find it, and the dashboard should already explain why we don't count it.
- **Everything expires.** Past `expires` the entry stops applying, the finding counts again, and the scan prints a warning naming the entry. A false positive is a claim about one page at one moment; pages change and axe changes.
- **Matching is narrow** — rule + page + element selector, never rule + site. Selectors are compared with attribute selectors stripped, because axe regenerates them unstably between runs. `"selector": "*"` widens to every node of that rule on that page, as an explicit choice.
- **`reason` is mandatory.** The risk this feature carries is becoming a quiet way to make numbers look better. A written justification is what keeps it honest, and what an auditor would ask for.

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
├── scan-core.mjs              # shared scoring rules — both scanners import this
├── sites.json                 # editable URL list
├── suppressions.json          # verified false positives (see above)
├── results.json               # scanner output (also written as dashboard/results.js)
├── dashboard/
│   ├── index.html             # entry
│   ├── app.js                 # overview / per-site / per-page views + search
│   ├── styles.css
│   └── results.js             # generated; window.SCAN_DATA = {...}
├── test/
│   ├── check-core-shared.js
│   ├── check-embeds.js
│   ├── check-engine.js
│   ├── check-merge.js
│   └── check-suppressions.js
├── test-fixtures/
│   └── broken.html
└── package.json
```

## Engine reference

- [axe-core](https://github.com/dequelabs/axe-core) — MPL-2.0
- [@axe-core/puppeteer](https://www.npmjs.com/package/@axe-core/puppeteer) — MPL-2.0
- Each violation links to `https://dequeuniversity.com/rules/axe/...` for remediation guidance.
