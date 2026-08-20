// scan.js — Run axe-core against each site in sites.json, write results.js for the dashboard.
//
// Usage:
//   node scan.js                 # scan all sites; BFS-crawl those with "crawl": true
//   node scan.js --only=OTI      # scan only the named site (smoke test)
//   node scan.js --no-crawl      # homepage only for every site (fast smoke test)
//   node scan.js --max-pages=25  # cap pages per crawled site (default 1000)
//   node scan.js --max-depth=3   # cap link-hops from the homepage (default 5)
//   node scan.js --collect-links # also write link-manifest.json (for check-links.mjs)
//   node scan.js --no-mobile     # desktop pass only (output matches pre-mobile scans)
//   node scan.js --no-settle     # skip the lazy-load scroll pass (pre-settle behavior)
//
// Output: results.js (a JS file that assigns window.SCAN_DATA = {...})
//   We use a JS file rather than JSON so the dashboard works on file:// without a server.

import { readFile, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { AxePuppeteer } from "@axe-core/puppeteer";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Each page gets two axe passes, one per viewport: a desktop-only scan never
// renders DOM behind mobile breakpoints (hamburger menus, collapsed nav), and
// viewport-sensitive rules like target-size only fire realistically at a
// phone width. The mobile pass keeps the desktop USER_AGENT on purpose —
// nyc.gov sites are responsive (CSS breakpoints), not UA-adaptive, and a
// familiar UA gives the WAF no new reason to serve a different page.
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844, isMobile: true, hasTouch: true };
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Transient Puppeteer/axe failures that mean "the frame tree moved under us
// mid-run" rather than "this page is broken." Pages that inject third-party
// tracking iframes (mPulse/boomerang, Facebook Pixel, etc.) attach and detach
// frames after networkidle2, so axe's per-frame injection can lose the race on
// the first pass and throw — a retry once the frames settle succeeds. Matched
// against err.message to decide whether scanPage retries instead of erroring.
const TRANSIENT_FRAME_ERROR =
  /not ready|detached|Execution context was destroyed|Target closed|frame got detached|Cannot find context/i;

// Lazy-loaded content is invisible to a scan that never scrolls, and the
// resulting findings are worse than useless — they are wrong. YouTube's
// channel-avatar <img> is the case that surfaced this: it ships with no src and
// visibility:hidden until it scrolls into view, and the accessible name
// computation excludes hidden nodes (https://www.w3.org/TR/accname-1.2/), so
// axe saw a button with no name and reported a critical button-name violation
// that no real user ever encounters.
//
// Step-scroll to the bottom so each step's IntersectionObservers fire, then
// return to the top — the axe pass should start where a reader would. Bounded
// three ways: step count, total elapsed time, and a growth guard that stops
// once the page stops getting taller (an infinite-scroll page would otherwise
// never finish).
const SETTLE_MAX_STEPS = 12;
const SETTLE_STEP_MS = 250;
const SETTLE_MAX_MS = 5_000;

async function settlePage(page) {
  if (!SETTLE_ENABLED) return;
  const started = Date.now();
  try {
    let lastHeight = -1;
    for (let step = 0; step < SETTLE_MAX_STEPS; step++) {
      if (Date.now() - started > SETTLE_MAX_MS) break;
      const { height, atBottom } = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        el.scrollTop += window.innerHeight;
        return {
          height: el.scrollHeight,
          atBottom: el.scrollTop + window.innerHeight >= el.scrollHeight - 2,
        };
      });
      await sleep(SETTLE_STEP_MS);
      // Done when we have reached the bottom and the page stopped growing.
      // If it is still growing at the bottom, it is an infinite-scroll feed —
      // the step/time bounds above are what stop us there.
      if (atBottom && height === lastHeight) break;
      lastHeight = height;
    }
    await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTop = 0;
    });
    await sleep(SETTLE_STEP_MS);
  } catch {
    // A navigation or detached frame mid-settle is not a scan failure: the axe
    // pass that follows reports whatever state the page actually ended up in.
  }
}

// Run axe against a settled page, retrying when a third-party frame detaches
// mid-injection. Each retry waits a beat for the frame tree to settle first.
async function analyzeWithRetry(page, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();
    } catch (err) {
      if (attempt >= attempts || !TRANSIENT_FRAME_ERROR.test(err.message)) throw err;
      await sleep(750 * attempt);
    }
  }
}

// Set in main() from --collect-links. When on, every page's full set of links
// (internal, external, and binary/document) is captured into LINK_MANIFEST for
// the broken-link checker (check-links.mjs). This is purely additive: the
// accessibility results written to results.js / results.json are unchanged.
let COLLECT_LINKS = false;
// Set in main() from --no-mobile. When off, pages get the desktop pass only
// and no viewports fields are emitted — the output is deliberately
// indistinguishable from pre-mobile-pass (legacy) records.
let MOBILE_ENABLED = true;
// Set in main() from --no-settle. When off, pages are scanned exactly where
// they load, without the lazy-load scroll pass — the pre-settle behavior, kept
// so an old scan can be reproduced for comparison.
let SETTLE_ENABLED = true;
// site name -> [{ url, links: [{ href, text, kind }] }], built during a
// --collect-links run and written to link-manifest.json at the end.
const LINK_MANIFEST = new Map();

// Record a page's full link inventory into the manifest. No-op unless
// --collect-links is set (the _allLinks arrays are empty otherwise anyway).
function recordLinks(siteName, pageUrl, links) {
  if (!COLLECT_LINKS) return;
  if (!LINK_MANIFEST.has(siteName)) LINK_MANIFEST.set(siteName, []);
  LINK_MANIFEST.get(siteName).push({ url: pageUrl, links });
}

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

// Third-party embeds whose findings are reported but NOT counted — excluded
// from counts, tiers, totals, and history. This is a deliberate case-by-case
// allowlist, not a blanket "ignore cross-origin iframes" rule:
//
//   YouTube qualifies because it is ubiquitous across nyc.gov, its player
//   markup churns week to week under us (over six consecutive weekly scans of
//   one page with a single embed, the finding set changed four times — zero
//   findings on 2026-07-24, three again on 2026-07-31), the findings are
//   almost never actionable by the embedding agency, and a video's content is
//   normally also on the page in another form.
//
// Other embeds — Tableau, Facebook, Maps — stay counted on purpose. An agency
// may not realize an embedded dashboard carries issues, and unlike a video
// those can gate content that exists nowhere else on the page.
const EXCLUDED_EMBEDS = [
  { vendor: "YouTube", host: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i },
];

export function excludedEmbedFor(src) {
  let host;
  try {
    host = new URL(src).host;
  } catch {
    return null;
  }
  return EXCLUDED_EMBEDS.find((e) => e.host.test(host)) ?? null;
}

// Resolve axe's frame selectors to the URLs they actually point at. axe reports
// a node inside an iframe as a target ARRAY — [frameSelector, …, elementSelector]
// — whose first entry is a CSS selector valid in the top document. The selector
// alone can't tell YouTube from Tableau (plenty are just `iframe[width="560"]`),
// so look the element up and read its src. Returns selector -> resolved URL.
async function embedFrameMap(page, violations) {
  const selectors = [
    ...new Set(
      violations
        .flatMap((v) => v.nodes)
        .filter((n) => Array.isArray(n.target) && n.target.length > 1)
        .map((n) => String(n.target[0]))
    ),
  ];
  if (!selectors.length) return new Map();
  const resolved = await page
    .evaluate(
      (sels) =>
        sels.map((sel) => {
          try {
            const el = document.querySelector(sel);
            const src = (el && (el.src || el.getAttribute("src"))) || "";
            return [sel, src ? new URL(src, location.href).href : ""];
          } catch {
            // An axe selector that no longer resolves (the frame moved between
            // the axe run and now) simply goes untagged and stays counted.
            return [sel, ""];
          }
        }),
      selectors
    )
    .catch(() => []);
  return new Map(resolved);
}

// Tag every violation node sitting inside an excluded embed. Tagged nodes stay
// in the results — the dashboard renders them in their own "Third-party embeds"
// section — but every counting path skips them, so they cannot move a tier.
export function tagEmbedNodes(violations, frameMap) {
  for (const v of violations) {
    for (const n of v.nodes) {
      if (!Array.isArray(n.target) || n.target.length < 2) continue;
      const src = frameMap.get(String(n.target[0]));
      const embed = src ? excludedEmbedFor(src) : null;
      if (embed) n.embed = { vendor: embed.vendor, url: src };
    }
  }
  return violations;
}

// Inventory the excluded embeds on the page, whether or not they produced a
// finding. The dashboard's banner is advice about the embed itself ("make sure
// essential information is also on the page in another form"), which holds
// regardless of what axe found — and tying it to findings would make it blink
// on and off week to week as YouTube ships player changes.
async function pageEmbeds(page) {
  const srcs = await page
    .evaluate(() => [...document.querySelectorAll("iframe[src]")].map((el) => el.src))
    .catch(() => []);
  const found = new Map();
  for (const src of srcs) {
    const embed = excludedEmbedFor(src);
    if (embed && !found.has(src)) found.set(src, { vendor: embed.vendor, url: src });
  }
  return [...found.values()];
}

// The nodes of a violation that count toward the score. Every total the
// dashboard and history report is built from this, so excluded-embed findings
// stay visible without ever affecting a tier.
export const countedNodes = (v) => v.nodes.filter((n) => !n.embed);
const countedTotal = (violations) =>
  violations.reduce((sum, v) => sum + countedNodes(v).length, 0);
const embedTotal = (violations) =>
  violations.reduce((sum, v) => sum + v.nodes.filter((n) => n.embed).length, 0);

export function tierFor(counts) {
  if (counts.critical > 0) return "red";
  if (counts.serious > 0) return "orange";
  if (counts.moderate > 0 || counts.minor > 0) return "yellow";
  return "green";
}

export function countByImpact(violations) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    const impact = v.impact ?? "minor";
    if (counts[impact] !== undefined) counts[impact] += countedNodes(v).length;
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

// Node identity across the two axe passes. Primary key: the exact target
// selector path, stringified (axe targets are arrays, nested for
// iframe/shadow DOM). But axe regenerates selectors per pass and its choice
// of disambiguating attributes is unstable — the same iframe came back as
// iframe[title=…][height=…][allowfullscreen=""] on the desktop pass and
// iframe[title=…][height=…][width="640"] on the mobile pass — so the same
// node can miss on the exact key and get double-counted. Fallback key:
// the target path with attribute selectors ([…]) stripped, which keeps the
// stable structural parts (tags, classes, ids, :nth-child). The fallback is
// only trusted when it is unambiguous — if two nodes share a stripped key,
// attributes were the real distinguishing feature and merging would be a
// guess, so we keep them separate (over-count beats mis-merge).
function normTargetKey(target) {
  const strip = (t) =>
    Array.isArray(t) ? t.map(strip) : String(t).replace(/\[[^\]]*\]/g, "");
  return JSON.stringify(target.map(strip));
}

// Merge desktop + mobile slim violation arrays into one deduplicated array.
// Key: rule id; within a rule, node identity per normTargetKey above.
// Desktop wins the node html/failureSummary when a node appears at both
// widths (responsive DOM can differ). Every merged violation gets
// viewports: ["desktop"] | ["mobile"] | ["desktop", "mobile"] — the union
// across its nodes; a node keeps its own viewports field only when it
// differs from the violation's, so readers resolve a node's viewports as
// (node.viewports ?? violation.viewports). Exported for test/check-merge.js.
export function mergeViewportViolations(desktop, mobile) {
  const AMBIGUOUS = Symbol("ambiguous");
  const byRule = new Map();
  for (const v of desktop) {
    byRule.set(v.id, {
      ...v,
      nodes: v.nodes.map((n) => ({ ...n, viewports: ["desktop"] })),
    });
  }
  for (const v of mobile) {
    const existing = byRule.get(v.id);
    if (!existing) {
      byRule.set(v.id, {
        ...v,
        nodes: v.nodes.map((n) => ({ ...n, viewports: ["mobile"] })),
      });
      continue;
    }
    const byTarget = new Map();
    const byNorm = new Map();
    const index = (node) => {
      byTarget.set(JSON.stringify(node.target), node);
      const nk = normTargetKey(node.target);
      byNorm.set(nk, byNorm.has(nk) ? AMBIGUOUS : node);
    };
    for (const node of existing.nodes) index(node);
    for (const n of v.nodes) {
      const exact = byTarget.get(JSON.stringify(n.target));
      const norm = byNorm.get(normTargetKey(n.target));
      // The fallback may only bridge the two passes: distinct nodes within
      // one axe pass are distinct elements even when only attributes tell
      // them apart, so never fold a mobile node into an already-mobile one.
      const fallback =
        norm !== AMBIGUOUS && norm && !norm.viewports.includes("mobile") ? norm : undefined;
      const match = exact ?? fallback;
      if (match) {
        if (!match.viewports.includes("mobile")) match.viewports.push("mobile");
      } else {
        const added = { ...n, viewports: ["mobile"] };
        existing.nodes.push(added);
        index(added);
      }
    }
  }
  return [...byRule.values()].map((v) => {
    const union = [];
    if (v.nodes.some((n) => n.viewports.includes("desktop"))) union.push("desktop");
    if (v.nodes.some((n) => n.viewports.includes("mobile"))) union.push("mobile");
    v.viewports = union;
    for (const n of v.nodes) {
      // Node viewports are always a subset of the union (both desktop-first),
      // so equal length means identical — drop the redundant copy.
      if (n.viewports.length === union.length) delete n.viewports;
    }
    return v;
  });
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

// Collect EVERY link on the page for the broken-link checker — internal,
// external, and binary/document links alike. Unlike sameOriginLinks (which
// feeds the crawl frontier and so is deliberately narrow), this is the raw
// inventory we later validate over HTTP. Returns { href, text, kind }:
//   kind = "internal" (same origin) | "external" (other http(s) origin)
//        | "binary" (PDF/doc/image/etc., by extension)
// mailto:/tel:/javascript: and pure #fragment links are skipped — nothing to
// HTTP-check. Query strings are kept (real external links carry them).
function allLinks(page, baseUrl) {
  return page.evaluate((base) => {
    const BINARY = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|mp[34]|geojson|json|csv|xml|kmz?)$/i;
    const origin = new URL(base).origin;
    const seen = new Set();
    const links = [];
    for (const a of document.querySelectorAll("a[href]")) {
      try {
        const u = new URL(a.href, base);
        if (!u.protocol.startsWith("http")) continue; // skip mailto:/tel:/javascript:
        u.hash = "";
        const href = u.href;
        if (seen.has(href)) continue;
        seen.add(href);
        const kind = BINARY.test(u.pathname)
          ? "binary"
          : u.origin === origin
            ? "internal"
            : "external";
        const text = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
        links.push({ href, text, kind });
      } catch {}
    }
    return links;
  }, baseUrl);
}

async function scanPage(browser, url, pathPrefix) {
  const start = Date.now();
  const page = await browser.newPage();
  try {
    if (USER_AGENT) await page.setUserAgent(USER_AGENT);
    await page.setViewport(DESKTOP_VIEWPORT);
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new Error(`HTTP ${status}`);
    }

    // Settle before axe runs, not after: lazy-loaded content that never enters
    // the viewport is scanned in its pre-load state, which produces findings
    // about placeholder markup no user ever sees.
    await settlePage(page);
    const result = await analyzeWithRetry(page);
    // Links are collected at the desktop width, before the viewport switch —
    // mobile CSS can hide nav links the crawl frontier needs. Settling first
    // also means lazily-rendered links make it into the crawl frontier.
    const links = await sameOriginLinks(page, page.url(), pathPrefix);
    const allLinksOnPage = COLLECT_LINKS ? await allLinks(page, page.url()) : [];
    const embeds = await pageEmbeds(page);

    let violations = slimViolations(result.violations);
    violations = tagEmbedNodes(violations, await embedFrameMap(page, violations));
    const viewportsScanned = ["desktop"];
    if (MOBILE_ENABLED) {
      // Second pass on the same loaded page: switching the viewport
      // re-evaluates media queries and fires resize handlers (enough for
      // responsive CSS and typical nav JS), but page JS that branched only at
      // load won't re-init — a known V1 limitation. No second goto: cheaper,
      // and no extra traffic for the WAF to judge.
      try {
        await page.setViewport(MOBILE_VIEWPORT);
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        );
        await new Promise((r) => setTimeout(r, 500));
        // Settle again at the mobile width: the narrow layout is taller, so
        // content that was already below the fold on desktop moves further
        // down, and lazy-loading is re-triggered against the new viewport.
        await settlePage(page);
        const mobileResult = await analyzeWithRetry(page);
        let mobileViolations = slimViolations(mobileResult.violations);
        mobileViolations = tagEmbedNodes(
          mobileViolations,
          await embedFrameMap(page, mobileViolations)
        );
        violations = mergeViewportViolations(violations, mobileViolations);
        viewportsScanned.push("mobile");
      } catch (err) {
        console.warn(`    mobile pass failed for ${url}: ${err.message} — keeping desktop results`);
        violations = violations.map((v) => ({ ...v, viewports: ["desktop"] }));
      }
    }
    const counts = countByImpact(violations);

    return {
      url,
      final_url: page.url(),
      tier: tierFor(counts),
      counts,
      total_violations: countedTotal(violations),
      // A rule whose every node sits in an excluded embed is not a rule this
      // page fails — it still appears in the embeds section, but it must not
      // inflate the rule count the scorecard reports.
      distinct_rules: violations.filter((v) => countedNodes(v).length > 0).length,
      embed_violations: embedTotal(violations),
      embeds,
      violations,
      // incomplete stays desktop-only in V1 — it is display-only (kept out of
      // counts/tier/history), so a second needs-review list isn't worth the merge.
      incomplete: slimIncomplete(result.incomplete),
      ...(MOBILE_ENABLED ? { viewports_scanned: viewportsScanned } : {}),
      scan_ms: Date.now() - start,
      error: null,
      _links: links,
      _allLinks: allLinksOnPage,
    };
  } catch (err) {
    return {
      url,
      final_url: url,
      tier: "error",
      counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      total_violations: 0,
      distinct_rules: 0,
      embed_violations: 0,
      embeds: [],
      violations: [],
      incomplete: [],
      scan_ms: Date.now() - start,
      error: err.message,
      _links: [],
      _allLinks: [],
    };
  } finally {
    // close() can itself throw (e.g. the CDP connection died mid-scan) — and a
    // throw here would replace the error record from the catch above and kill
    // the whole run instead of just this page.
    await page.close().catch(() => {});
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
  // A page that failed to scan contributes zero counts, so a site where nothing
  // came back looks identical to a clean one by counts alone. Tier it as an
  // error instead: a site we never reached has no result to report, and
  // "clean" would overstate what the scan actually established.
  const allFailed = pages.length > 0 && pages.every((p) => p.error);
  return {
    name: site.name,
    url: site.url,
    scanned_at: new Date().toISOString(),
    tier: allFailed ? "error" : tierFor(counts),
    counts,
    total_violations: pages.reduce((sum, p) => sum + p.total_violations, 0),
    distinct_rules: new Set(
      pages.flatMap((p) =>
        p.violations.filter((v) => countedNodes(v).length > 0).map((v) => v.id)
      )
    ).size,
    // Reported alongside the score, never inside it: how many findings sit in
    // excluded third-party embeds, and which embeds the site carries.
    embed_violations: pages.reduce((sum, p) => sum + (p.embed_violations ?? 0), 0),
    embed_vendors: [
      ...new Set(pages.flatMap((p) => (p.embeds ?? []).map((e) => e.vendor))),
    ],
    pages,
    scan_ms: pages.reduce((sum, p) => sum + p.scan_ms, 0),
    error: allFailed ? pages[0].error : null,
    // A scan that reached nothing is never "complete", whatever the caller
    // passed. Two call sites hand in a hard-coded true (fixed-list sites, and
    // sites with crawling off), so without this a non-crawling site that timed
    // out would be recorded as a finished scan with zero findings.
    crawlComplete: allFailed ? false : crawlComplete ?? null,
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
      const { _links, _allLinks, ...result } = await scanPage(browser, url, null);
      pages.push(result);
      recordLinks(site.name, result.final_url ?? url, _allLinks);
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
  const { _links: homeLinks, _allLinks: homeAllLinks, ...homeRest } = homepage;
  const pages = [homeRest];
  recordLinks(site.name, homeRest.final_url ?? site.url, homeAllLinks);
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
      const { _links, _allLinks, ...pageResult } = result;
      pages.push(pageResult);
      recordLinks(site.name, pageResult.final_url ?? url, _allLinks);
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
  const out = { only: null, crawl: true, maxPages: DEFAULT_MAX_PAGES, maxDepth: DEFAULT_MAX_DEPTH, collectLinks: false, mobile: true, settle: true };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--only=")) out.only = a.slice("--only=".length);
    else if (a === "--no-crawl") out.crawl = false;
    else if (a === "--collect-links") out.collectLinks = true;
    else if (a === "--no-mobile") out.mobile = false;
    else if (a === "--no-settle") out.settle = false;
    else if (a.startsWith("--max-pages=")) out.maxPages = Number(a.slice("--max-pages=".length));
    else if (a.startsWith("--max-depth=")) out.maxDepth = Number(a.slice("--max-depth=".length));
  }
  return out;
}

// Append a rule-level snapshot for each freshly-scanned site to history.json.
// Each entry is { date, site, pages, crawlComplete, viewports, rules: [{ id,
// impact, count }] }; a scan that failed outright instead records `rules: null`
// alongside an `error` message. `viewports` records the scan configuration so the
// dashboard's trend chart can mark where mobile scanning began (counts jump
// there for tool reasons, not site reasons); entries from before the mobile
// pass simply lack the key.
async function recordHistory(freshSites) {
  let history = [];
  try {
    history = JSON.parse(await readFile("history.json", "utf8"));
  } catch {}
  const date = new Date().toISOString();
  for (const site of freshSites) {
    // A site we never reached has nothing to measure, and the three cases have
    // to stay distinguishable: `rules: []` means we looked and found nothing,
    // `rules: null` means we couldn't look, and no entry at all means we never
    // tried. Writing [] here would read as "every finding fixed"; writing
    // nothing would hide a site that fails every week. Record the attempt with
    // the measurement explicitly absent — the dashboard plots null as a gap.
    if (site.tier === "error") {
      history.push({
        date,
        site: site.name,
        pages: 0,
        crawlComplete: false,
        viewports: MOBILE_ENABLED ? ["desktop", "mobile"] : ["desktop"],
        error: site.error,
        rules: null,
      });
      continue;
    }
    const byRule = {};
    const pages = site.pages || [site];
    for (const p of pages) {
      for (const v of p.violations || []) {
        // Excluded-embed nodes are absent from every other total; letting them
        // into history would put them back into the trend chart by the side door.
        const counted = countedNodes(v).length;
        if (!counted) continue;
        if (!byRule[v.id]) byRule[v.id] = { id: v.id, impact: v.impact, count: 0 };
        byRule[v.id].count += counted;
      }
    }
    history.push({
      date,
      site: site.name,
      pages: pages.length,
      crawlComplete: site.crawlComplete ?? null,
      viewports: MOBILE_ENABLED ? ["desktop", "mobile"] : ["desktop"],
      // Scan configuration, recorded for the same reason `viewports` is: counts
      // step at a methodology change for tool reasons, not site reasons, and the
      // chart needs to be able to mark where. Settling finds MORE (lazy-loaded
      // content is now scanned); embed exclusion counts FEWER. Both landed in
      // the same scan, so the step is a net of two opposing shifts.
      settled: SETTLE_ENABLED,
      excludedEmbeds: EXCLUDED_EMBEDS.map((e) => e.vendor),
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
  const { only, crawl, maxPages, maxDepth, collectLinks, mobile, settle } = parseArgs(process.argv);
  COLLECT_LINKS = collectLinks;
  MOBILE_ENABLED = mobile;
  SETTLE_ENABLED = settle;
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

  // History first, then the final write. writeResults regenerates
  // dashboard/history.js from history.json, so appending this run's entry
  // afterwards would leave the chart one scan behind — the run that just
  // finished would not appear until the next one.
  await recordHistory(results);
  // Final write. Checkpoints during the crawl have been flushing partial
  // results all along; this is the authoritative one.
  const mergedSites = await writeResults(all, results);

  // When --collect-links was set, emit the link inventory for check-links.mjs.
  // Only the sites scanned THIS run are included (so `--only=OTI --collect-links`
  // yields an OTI-only manifest); check-links.mjs validates whatever it finds.
  if (COLLECT_LINKS) {
    const manifest = {
      collected_at: new Date().toISOString(),
      sites: results.map((r) => ({
        name: r.name,
        url: r.url,
        pages: LINK_MANIFEST.get(r.name) ?? [],
      })),
    };
    await writeFile("link-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    const totalLinks = manifest.sites.reduce(
      (sum, s) => sum + s.pages.reduce((n, p) => n + p.links.length, 0), 0
    );
    console.log(`Wrote link-manifest.json — ${totalLinks} link(s) across ${manifest.sites.length} site(s).`);
  }
  const scannedNames = new Set(results.map((r) => r.name));
  const cached = mergedSites.filter((s) => !scannedNames.has(s.name)).map((s) => s.name);

  const totalPages = mergedSites.reduce((sum, r) => sum + r.pages.length, 0);
  console.log(
    `\nDone. Scanned ${results.length} site(s) this run` +
      (cached.length ? `; kept cached: ${cached.join(", ")}` : "") + "."
  );
  console.log(`Wrote ${mergedSites.length} site(s) / ${totalPages} page(s) to dashboard/results.js and results.json.`);
}

// Guarded so tests can import the exported helpers without starting a scan.
if (process.argv[1]?.endsWith("scan.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
