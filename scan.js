// scan.js — Run axe-core against each site in sites.json, write results.js for the dashboard.
//
// Usage:
//   node scan.js                 # scan all sites; BFS-crawl those with "crawl": true
//   node scan.js --only=OTI      # scan only the named site (smoke test)
//   node scan.js --no-crawl      # homepage only for every site (fast smoke test)
//   node scan.js --max-pages=25  # cap pages per crawled site (default 1000)
//   node scan.js --max-depth=3   # cap link-hops from the homepage (default 5)
//
// Output: results.js (a JS file that assigns window.SCAN_DATA = {...})
//   We use a JS file rather than JSON so the dashboard works on file:// without a server.

import { readFile, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { AxePuppeteer } from "@axe-core/puppeteer";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Crawl bounds (override per run with --max-pages / --max-depth). A crawl is a
// breadth-first walk from the homepage, scoped by the site's pathPrefix.
const DEFAULT_MAX_PAGES = 1000;
const DEFAULT_MAX_DEPTH = 5;
// On a long crawl, flush partial results to disk every this many pages so an
// interrupted run still leaves valid, saved progress (see writeResults).
const CHECKPOINT_EVERY = 25;

// Set in main() to the bundled Chrome's UA with "Headless" stripped out, so the
// scanner presents as a normal desktop Chrome. Sites can serve a degraded or
// blocked response to the default headless UA; a standard UA gives the scan the
// same page a real user would see.
let USER_AGENT = null;

// Query/hash-stripped href — the identity the crawl de-dupes pages on, so a
// page reachable by several URLs (or via the post-redirect homepage URL) is
// scanned exactly once.
const norm = (href) => {
  try {
    const u = new URL(href);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return href;
  }
};

function tierFor(counts) {
  if (counts.critical > 0) return "red";
  if (counts.serious > 0) return "orange";
  if (counts.moderate > 0 || counts.minor > 0) return "yellow";
  return "green";
}

function countByImpact(violations) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    const impact = v.impact ?? "minor";
    if (counts[impact] !== undefined) counts[impact] += v.nodes.length;
  }
  return counts;
}

function addCounts(a, b) {
  return {
    critical: a.critical + b.critical,
    serious: a.serious + b.serious,
    moderate: a.moderate + b.moderate,
    minor: a.minor + b.minor,
  };
}

function slimViolations(violations) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    tags: v.tags.filter((t) => t.startsWith("wcag")),
    nodes: v.nodes.map((n) => ({
      target: n.target,
      html: n.html.length > 240 ? n.html.slice(0, 240) + "…" : n.html,
      failureSummary: n.failureSummary,
    })),
  }));
}

// Slim axe's "incomplete" (needs-review) results down to enough to count and
// locate: id, impact, node count, first few selectors. axe computes these for
// free and they can't be backfilled into old scans, but the raw array is far
// too noisy to display — so we store it and keep it OUT of counts, tier,
// total_violations, distinct_rules, and history.
function slimIncomplete(incomplete) {
  return incomplete.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target),
  }));
}

// Collect same-origin links from the page. If pathPrefix is given, only links
// whose pathname starts with it are kept — this keeps the crawl inside the
// target site (e.g. "/main") instead of wandering into other agencies' subsites
// (e.g. "/site/doh/...") that happen to be linked from the homepage.
// Links with a query string are skipped: on nyc.gov these are transient
// event-detail pages (?permalinkName=…) that change week to week and would
// make scans non-reproducible.
// Binary/document links (.pdf, .doc, images, …) are skipped too: axe would
// scan Chrome's viewer shell rather than the document, producing artifact
// violations — on legacy /html/ sites PDFs can otherwise eat most of the
// crawl budget (142 of DOT's first 250 URLs).
function sameOriginLinks(page, baseUrl, pathPrefix) {
  return page.evaluate((base, prefix) => {
    const BINARY = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|mp[34]|geojson|json|csv|xml|kmz?)$/i;
    const origin = new URL(base).origin;
    // Normalize the page's own resolved URL (strip query/hash) so a nav link
    // back to it — e.g. "/main" when the homepage redirected to "/main?/" —
    // is recognized as self and not scanned a second time.
    const self = new URL(base);
    self.search = "";
    self.hash = "";
    const selfHref = self.href;
    const seen = new Set();
    const links = [];
    for (const a of document.querySelectorAll("a[href]")) {
      try {
        const u = new URL(a.href, base);
        u.hash = "";
        const href = u.href;
        if (
          u.origin === origin &&
          !seen.has(href) &&
          href !== selfHref &&
          u.protocol.startsWith("http") &&
          !u.search &&
          !BINARY.test(u.pathname) &&
          (!prefix || u.pathname.startsWith(prefix))
        ) {
          seen.add(href);
          links.push(href);
        }
      } catch {}
    }
    return links;
  }, baseUrl, pathPrefix);
}

async function scanPage(browser, url, pathPrefix) {
  const start = Date.now();
  const page = await browser.newPage();
  try {
    if (USER_AGENT) await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new Error(`HTTP ${status}`);
    }

    const result = await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();
    const violations = slimViolations(result.violations);
    const counts = countByImpact(result.violations);
    const links = await sameOriginLinks(page, page.url(), pathPrefix);

    return {
      url,
      final_url: page.url(),
      tier: tierFor(counts),
      counts,
      total_violations: violations.reduce((sum, v) => sum + v.nodes.length, 0),
      distinct_rules: violations.length,
      violations,
      incomplete: slimIncomplete(result.incomplete),
      scan_ms: Date.now() - start,
      error: null,
      _links: links,
    };
  } catch (err) {
    return {
      url,
      final_url: url,
      tier: "error",
      counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      total_violations: 0,
      distinct_rules: 0,
      violations: [],
      incomplete: [],
      scan_ms: Date.now() - start,
      error: err.message,
      _links: [],
    };
  } finally {
    await page.close();
  }
}

// Build a scan.js site record from the pages crawled so far. Used both for the
// final result and for mid-crawl checkpoints, so the shape is identical either
// way.
function assembleSite(site, pages, crawlComplete) {
  const counts = pages.reduce(
    (acc, p) => addCounts(acc, p.counts),
    { critical: 0, serious: 0, moderate: 0, minor: 0 }
  );
  return {
    name: site.name,
    url: site.url,
    scanned_at: new Date().toISOString(),
    tier: tierFor(counts),
    counts,
    total_violations: pages.reduce((sum, p) => sum + p.total_violations, 0),
    distinct_rules: new Set(pages.flatMap((p) => p.violations.map((v) => v.id))).size,
    pages,
    scan_ms: pages.reduce((sum, p) => sum + p.scan_ms, 0),
    error: pages.length === 1 && pages[0].error ? pages[0].error : null,
    crawlComplete: crawlComplete ?? null,
  };
}

// Crawl is opt-in per site via `"crawl": true` in sites.json. When enabled it
// is a breadth-first walk from the homepage: each scanned page contributes its
// in-scope links to the frontier, bounded by maxPages (total pages incl. the
// homepage) and maxDepth (link-hops from the homepage). `--no-crawl` forces
// homepage-only. `pathPrefix` (from sites.json) scopes which links are followed.
// `checkpoint`, if given, is awaited with a partial site record every
// CHECKPOINT_EVERY pages so a long crawl survives an interruption.
async function scanSite(browser, site, crawlEnabled, { maxPages, maxDepth }, checkpoint) {
  // Fixed-list sites: `"pages": [url, …]` in sites.json scans exactly those
  // URLs, no crawl. Used for curated sets that span multiple sites (so they
  // have no single homepage to walk from).
  if (Array.isArray(site.pages)) {
    const pages = [];
    for (const url of site.pages) {
      const { _links, ...result } = await scanPage(browser, url, null);
      pages.push(result);
      if (pages.length > 1) {
        console.log(
          `${"".padEnd(12)} └ ${url} … ` +
            (result.error ? `ERROR (${result.error})` : `${result.tier.toUpperCase().padEnd(6)} ${result.total_violations} issues / ${result.scan_ms}ms`)
        );
      }
    }
    return assembleSite(site, pages, true);
  }

  const homepage = await scanPage(browser, site.url, site.pathPrefix);
  const { _links: homeLinks, ...homeRest } = homepage;
  const pages = [homeRest];
  let crawlComplete = !site.crawl || !crawlEnabled ? true : false;

  if (crawlEnabled && site.crawl && !homepage.error) {
    // The homepage is marked visited under BOTH its requested and
    // post-redirect URLs, so a subpage linking back to it ("/main") can't
    // re-enqueue it. depthOf doubles as the "already queued" guard.
    const visited = new Set([norm(site.url), norm(homepage.final_url)]);
    const depthOf = new Map();
    const queue = [];
    const enqueue = (href, depth) => {
      const k = norm(href);
      if (!visited.has(k) && !depthOf.has(k)) {
        depthOf.set(k, depth);
        queue.push(href);
      }
    };

    for (const l of homeLinks) enqueue(l, 1);

    while (queue.length && pages.length < maxPages) {
      const url = queue.shift();
      const key = norm(url);
      if (visited.has(key)) continue;
      visited.add(key);
      const depth = depthOf.get(key) ?? 1;

      process.stdout.write(`${"".padEnd(12)} └ d${depth} ${url} … `);
      const result = await scanPage(browser, url, site.pathPrefix);
      const { _links, ...pageResult } = result;
      pages.push(pageResult);
      if (result.error) {
        console.log(`ERROR (${result.error})`);
      } else {
        console.log(`${result.tier.toUpperCase().padEnd(6)} ${result.total_violations} issues / ${result.scan_ms}ms`);
      }

      if (!result.error && depth < maxDepth) {
        for (const l of _links) enqueue(l, depth + 1);
      }

      // Checkpoint: flush partial results to disk so a long crawl that is
      // interrupted still leaves valid, saved progress.
      if (checkpoint && pages.length % CHECKPOINT_EVERY === 0) {
        await checkpoint(assembleSite(site, pages, false));
        console.log(`${"".padEnd(12)} ·· checkpoint saved — ${pages.length} pages`);
      }
    }

    crawlComplete = queue.length === 0;
  }

  return assembleSite(site, pages, crawlComplete);
}

function parseArgs(argv) {
  const out = { only: null, crawl: true, maxPages: DEFAULT_MAX_PAGES, maxDepth: DEFAULT_MAX_DEPTH };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--only=")) out.only = a.slice("--only=".length);
    else if (a === "--no-crawl") out.crawl = false;
    else if (a.startsWith("--max-pages=")) out.maxPages = Number(a.slice("--max-pages=".length));
    else if (a.startsWith("--max-depth=")) out.maxDepth = Number(a.slice("--max-depth=".length));
  }
  return out;
}

// Append a rule-level snapshot for each freshly-scanned site to history.json.
// Each entry is { date, site, pages, rules: [{ id, impact, count }] }.
async function recordHistory(freshSites) {
  let history = [];
  try {
    history = JSON.parse(await readFile("history.json", "utf8"));
  } catch {}
  const date = new Date().toISOString();
  for (const site of freshSites) {
    const byRule = {};
    const pages = site.pages || [site];
    for (const p of pages) {
      for (const v of p.violations || []) {
        if (!byRule[v.id]) byRule[v.id] = { id: v.id, impact: v.impact, count: 0 };
        byRule[v.id].count += v.nodes.length;
      }
    }
    history.push({
      date,
      site: site.name,
      pages: pages.length,
      crawlComplete: site.crawlComplete ?? null,
      rules: Object.values(byRule),
    });
  }
  await writeFile("history.json", JSON.stringify(history, null, 2) + "\n");
}

// Merge freshly-scanned sites with whatever is already in results.json (so a
// targeted run keeps every other site) and write results.js + results.json,
// emitted in sites.json order. Called for the final result AND for every
// mid-crawl checkpoint, so an interrupted long crawl still leaves a valid file.
async function writeResults(all, results) {
  let prior = [];
  try {
    prior = JSON.parse(await readFile("results.json", "utf8")).sites ?? [];
  } catch {}
  const freshByName = new Map(results.map((r) => [r.name, r]));
  const priorByName = new Map(prior.map((r) => [r.name, r]));
  const mergedSites = all
    .map((s) => freshByName.get(s.name) ?? priorByName.get(s.name))
    .filter(Boolean);

  const payload = {
    scanned_at: new Date().toISOString(),
    wcag_target: "WCAG 2.2 AA",
    engine: "axe-core (via @axe-core/puppeteer)",
    sites: mergedSites,
  };
  const js = `// Auto-generated by scan.js — do not edit by hand.\nwindow.SCAN_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  await writeFile("dashboard/results.js", js);
  await writeFile("results.json", JSON.stringify(payload, null, 2) + "\n");

  // Write history data for the dashboard chart.
  try {
    const hist = JSON.parse(await readFile("history.json", "utf8"));
    const hjs = `// Auto-generated — do not edit by hand.\nwindow.HISTORY_DATA = ${JSON.stringify(hist)};\n`;
    await writeFile("dashboard/history.js", hjs);
  } catch {}

  return mergedSites;
}

async function main() {
  const { only, crawl, maxPages, maxDepth } = parseArgs(process.argv);
  const all = JSON.parse(await readFile("sites.json", "utf8"));
  // "app": true entries (the finder web-apps) can't be link-crawled — their
  // content is gated behind form submits / SPA interaction. scan-finders.mjs
  // drives those; scan.js skips them so a full run can't overwrite that data.
  const matched = only ? all.filter((s) => s.name === only) : all;
  const sites = matched.filter((s) => !s.app);
  const skippedApps = matched.filter((s) => s.app).map((s) => s.name);

  if (skippedApps.length) {
    console.log(`Skipping app-driven site(s): ${skippedApps.join(", ")} — run: node scan-finders.mjs`);
  }
  if (sites.length === 0) {
    if (matched.length === 0) {
      console.error(`No sites matched. --only=${only} not found in sites.json.`);
      process.exit(1);
    }
    console.log("Nothing to crawl this run.");
    return;
  }

  const crawlSites = sites.filter((s) => crawl && s.crawl).map((s) => s.name);
  const mode = crawlSites.length
    ? `BFS-crawling ${crawlSites.join(", ")} (≤${maxPages} pages, depth ≤${maxDepth}); others homepage-only`
    : "homepage only";
  console.log(`Scanning ${sites.length} site(s) against WCAG 2.2 AA — ${mode}…`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  USER_AGENT = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");

  const results = [];
  for (const site of sites) {
    process.stdout.write(`  ${site.name.padEnd(10)} ${site.url} … `);
    // Checkpoint callback: write a partial results.json mid-crawl so progress
    // survives an interruption. `results` holds sites already finished this run.
    const checkpoint = (partialSite) => writeResults(all, [...results, partialSite]);
    const r = await scanSite(browser, site, crawl, { maxPages, maxDepth }, checkpoint);
    const hp = r.pages[0];
    if (hp.error) {
      console.log(`ERROR (${hp.error})`);
    } else {
      console.log(`${hp.tier.toUpperCase().padEnd(6)} ${hp.total_violations} issues / ${hp.scan_ms}ms`);
    }
    if (r.pages.length > 1) {
      console.log(`${"".padEnd(12)} ── site total: ${r.tier.toUpperCase()} ${r.total_violations} issues / ${r.distinct_rules} rules / ${r.pages.length} pages / ${r.scan_ms}ms`);
    }
    results.push(r);
  }

  await browser.close();

  // Final write. Checkpoints during the crawl have been flushing partial
  // results all along; this is the authoritative one.
  const mergedSites = await writeResults(all, results);
  await recordHistory(results);
  const scannedNames = new Set(results.map((r) => r.name));
  const cached = mergedSites.filter((s) => !scannedNames.has(s.name)).map((s) => s.name);

  const totalPages = mergedSites.reduce((sum, r) => sum + r.pages.length, 0);
  console.log(
    `\nDone. Scanned ${results.length} site(s) this run` +
      (cached.length ? `; kept cached: ${cached.join(", ")}` : "") + "."
  );
  console.log(`Wrote ${mergedSites.length} site(s) / ${totalPages} page(s) to dashboard/results.js and results.json.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
