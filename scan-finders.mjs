// scan-finders.mjs — Interaction-driven accessibility scan of the two senior
// "finder" web-apps (Aging Service Finder, Aging Activities Finder).
//
// Why this exists separately from scan.js: scan.js is a LINK CRAWLER — it
// follows <a href> links. The finder apps don't expose their real content that
// way. The Service Finder gates results behind an ASP.NET form POST; the
// Activities Finder is a React SPA. So we DRIVE each app: walk it through its
// real user-flow states (landing → results → detail) and run axe at each one.
//
// Each state is emitted as a "page"-shaped record (with a human `label`) so the
// output merges into results.js / results.json exactly like a crawled site —
// the dashboard renders it with no schema changes (app.js reads page.label).
//
// scan.js skips "app": true sites for exactly this reason, so the two tools
// never clobber each other's data; both merge into the same results.json.
//
// Usage:
//   node scan-finders.mjs                          # both finder apps
//   node scan-finders.mjs --only="Aging Service Finder"

import { readFile, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { AxePuppeteer } from "@axe-core/puppeteer";

// ---- shared axe helpers (mirror scan.js — keep in sync) ---------------------
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function tierFor(counts) {
  if (counts.critical > 0 || counts.serious > 0) return "red";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- state capture ---------------------------------------------------------

// Run axe on the page's CURRENT (post-interaction) DOM and return a record
// shaped like a scan.js "page", plus a human `label` for the state — a postback
// app / SPA has no distinct URL per state for the dashboard to show.
async function captureState(page, label) {
  const start = Date.now();
  try {
    const result = await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();
    const violations = slimViolations(result.violations);
    const counts = countByImpact(result.violations);
    const rec = {
      url: page.url(),
      final_url: page.url(),
      label,
      tier: tierFor(counts),
      counts,
      total_violations: violations.reduce((s, v) => s + v.nodes.length, 0),
      distinct_rules: violations.length,
      violations,
      scan_ms: Date.now() - start,
      error: null,
    };
    console.log(`     ✓ ${label.padEnd(36)} ${rec.tier.toUpperCase().padEnd(6)} ${rec.total_violations} issues`);
    return rec;
  } catch (err) {
    console.log(`     ✗ ${label.padEnd(36)} ERROR ${err.message}`);
    return {
      url: page.url(),
      final_url: page.url(),
      label,
      tier: "error",
      counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      total_violations: 0,
      distinct_rules: 0,
      violations: [],
      scan_ms: Date.now() - start,
      error: err.message,
    };
  }
}

// Roll per-state records up into a scan.js-shaped site object.
function assembleSite(site, states) {
  const counts = states.reduce(
    (acc, s) => addCounts(acc, s.counts),
    { critical: 0, serious: 0, moderate: 0, minor: 0 }
  );
  return {
    name: site.name,
    url: site.url,
    scanned_at: new Date().toISOString(),
    tier: tierFor(counts),
    counts,
    total_violations: states.reduce((s, p) => s + p.total_violations, 0),
    distinct_rules: new Set(states.flatMap((p) => p.violations.map((v) => v.id))).size,
    pages: states,
    scan_ms: states.reduce((s, p) => s + p.scan_ms, 0),
    error: states.length > 0 && states.every((p) => p.error) ? states[0].error : null,
    crawlComplete: true,
  };
}

// ---- interaction helpers ---------------------------------------------------

// First element matching `selector` whose trimmed text equals (or contains)
// `text`. Stale handles from a mid-walk SPA re-render are skipped.
async function handleByText(page, selector, text, exact = true) {
  for (const h of await page.$$(selector)) {
    let t = "";
    try {
      t = (await h.evaluate((e) => e.textContent.replace(/\s+/g, " ").trim())) || "";
    } catch {
      continue;
    }
    if (exact ? t === text : t.toLowerCase().includes(text.toLowerCase())) return h;
  }
  return null;
}

// Click a handle and wait for either a full-page navigation (server postback)
// or, if none happens, a fixed settle (SPA in-place render).
async function clickAndSettle(page, handle, settleMs) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {}),
    handle.click().catch(() => {}),
  ]);
  await sleep(settleMs);
}

// ---- Service Finder: ASP.NET form, results behind a POST -------------------

async function scanServiceFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  try {
    // ① Landing — the search form itself.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(1500);
    states.push(await captureState(page, "Landing — search form"));

    // ② Results — a "Browse by Program Type" quick-link (realistic
    //    "I need case management" path); these are plain <a> links.
    const browseFor = "Case Management";
    const browseLink = await handleByText(page, "a", browseFor);
    if (browseLink) {
      await clickAndSettle(page, browseLink, 2000);
      console.log(`     → results page: ${page.url()}`);
      states.push(await captureState(page, `Search results — ${browseFor}`));
    } else {
      console.log(`     ! "${browseFor}" quick-link not found — skipping results state`);
    }

    // ③ Service detail — first in-app result link on the results page.
    const detail = await page.evaluate(() => {
      const here = location.href.split("#")[0];
      const cands = [...document.querySelectorAll("a[href]")]
        .map((a) => ({ text: a.textContent.replace(/\s+/g, " ").trim(), href: a.href }))
        .filter(
          (l) =>
            l.href.startsWith("http") &&
            /a125-egovt\.nyc\.gov/i.test(l.href) &&
            l.href.split("#")[0] !== here &&
            !/AgingService\/?$/i.test(l.href) // not back to the finder home
        );
      const pick = cands.find((l) => /[?&]|\/\d+|detail|provider/i.test(l.href)) || cands[0] || null;
      return { sample: cands.slice(0, 12), pick };
    });
    console.log("     results-page in-app links (sample):");
    detail.sample.forEach((l) => console.log(`        ${l.href}  "${l.text.slice(0, 40)}"`));
    if (detail.pick) {
      await page.goto(detail.pick.href, { waitUntil: "networkidle2", timeout: 60_000 });
      await sleep(1500);
      states.push(await captureState(page, "Service detail"));
    } else {
      console.log("     ! no service-detail link found on results page");
    }
  } catch (err) {
    console.log(`     ! Service Finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states);
}

// ---- DOE School Search: React SPA atop ArcGIS map --------------------------

async function scanSchoolSearch(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  try {
    // ① Landing — map + sidebar with name search, Grade + Borough filters.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(5000); // React + ArcGIS take a beat
    states.push(await captureState(page, "Landing — map + search form"));

    // ② Schools tab — switches the sidebar to a list view. No form submit, so
    //    this state is reachable even if the heavy ArcGIS filter flow chokes.
    const schoolsTab = await page.$('a[href$="#nav-school"]');
    if (schoolsTab) {
      await schoolsTab.click().catch(() => {});
      await sleep(2500);
      states.push(await captureState(page, "Schools list tab"));
    } else {
      console.log("     ! Schools tab not found — skipping list state");
    }

    // ③ Filtered results — set Borough=Manhattan and submit the filters form.
    //    The first input[type=submit] in the DOM is the filters submit (the
    //    name-search submit is wired to the autocomplete dropdown above it).
    //    A borough filter triggers an ArcGIS update — give it a generous settle.
    try {
      const filtersTab = await page.$('a[href$="#nav-filters"]');
      if (filtersTab) { await filtersTab.click().catch(() => {}); await sleep(800); }
      await page.select("#Borough", "M");
      await sleep(400);
      const submits = await page.$$("input[type=submit]");
      if (submits.length) {
        await submits[submits.length - 1].click().catch(() => {});
        await sleep(6000);
        // Switch back to Schools tab so the rendered list is what axe sees.
        const tab = await page.$('a[href$="#nav-school"]');
        if (tab) { await tab.click().catch(() => {}); await sleep(1500); }
        states.push(await captureState(page, "Filtered — Manhattan schools"));
      } else {
        console.log("     ! filters submit not found");
      }
    } catch (err) {
      console.log(`     ! filter flow error: ${err.message}`);
    }
  } catch (err) {
    console.log(`     ! School Search flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states);
}

// ---- Food Help Finder: ArcGIS map + React sidebar at finder.nyc.gov -------

async function scanFoodHelpFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  try {
    // ① Landing — map + sidebar with "What is Food Help NYC?" content.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(4000); // ArcGIS map needs a beat to settle
    states.push(await captureState(page, "Landing — map + intro"));

    // ② Locations list — typing an address + Enter routes to /foodhelp/locations
    //    with a real list of nearby pantries/kitchens. The Esri autocomplete
    //    accepts free-text + Enter without needing a suggestion click.
    const term = "Times Square, Manhattan";
    const box = await page.$("#searchDiv-input");
    if (box) {
      await box.click({ clickCount: 3 });
      await box.type(term, { delay: 30 });
      await sleep(1200);
      await page.keyboard.press("Enter");
      await sleep(5000);
      console.log(`     → searched "${term}", url now: ${page.url()}`);
      states.push(await captureState(page, `Locations near "${term}"`));
    } else {
      console.log("     ! address search box not found — skipping locations state");
    }
  } catch (err) {
    console.log(`     ! Food Help Finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states);
}

// ---- Activities Finder: React SPA, content renders client-side -------------

async function scanActivitiesFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  try {
    // ① Landing — the SPA renders an event listing on load.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(3500); // let the React app fetch + render event data
    states.push(await captureState(page, "Landing — event listing"));

    // ② Search results — type a realistic query and submit. Enter triggers a
    //    client-side route change, so wait for the navigation before scanning.
    const term = "art";
    const searchBox = await page.$('input[placeholder="Search here..."]');
    if (searchBox) {
      await searchBox.click({ clickCount: 3 });
      await searchBox.type(term, { delay: 40 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {}),
        page.keyboard.press("Enter"),
      ]);
      await sleep(3500);
      console.log(`     → searched "${term}", url now: ${page.url()}`);
      states.push(await captureState(page, `Search results — "${term}"`));
    } else {
      console.log("     ! search box not found — skipping search state");
    }

    // ③ Event detail — open the first "View Event Details".
    const detailHref = await page.evaluate(() => {
      const a = [...document.querySelectorAll("a")].find(
        (x) => x.textContent.replace(/\s+/g, " ").trim().toLowerCase() === "view event details"
      );
      return a ? a.href : null;
    });
    if (detailHref && detailHref.startsWith("http")) {
      await page.goto(detailHref, { waitUntil: "networkidle2", timeout: 60_000 });
      await sleep(3000);
      console.log(`     → event detail: ${page.url()}`);
      states.push(await captureState(page, "Event detail"));
    } else {
      console.log("     ! no event-detail link found");
    }
  } catch (err) {
    console.log(`     ! Activities Finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states);
}

// ---- Summer in NYC: client-side questionnaire wizard → activities map ------
// "Get Started" opens an in-place SPA questionnaire (age slider, audience
// radios, interest checkboxes, neighborhood search) that keeps the same URL for
// every step, so a link crawl only ever sees the splash screen. We click
// through and run axe at each state. The final "See activities" stays disabled
// until the location field is filled from its autocomplete, which then reveals
// the results map + activity list — the app's real payload.
async function scanSummerFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  try {
    // ① Splash — the marketing landing state, before the wizard opens.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(1500);
    states.push(await captureState(page, "Splash — landing"));

    // ② Open the wizard. "Get Started" is a <button> with an onclick handler
    //    (no href / navigation), so the URL never changes from here on.
    const start = await handleByText(page, "button", "Get Started");
    if (!start) {
      console.log('     ! "Get Started" not found — only the splash was scanned');
      return assembleSite(site, states);
    }
    await clickAndSettle(page, start, 1800);

    // ③ Walk the questionnaire. Each step advances on "Continue" (which works
    //    on the wizard's defaults); the final location step swaps that button
    //    for "See activities". Cap the loop so a UI change can't spin forever.
    for (let step = 1; step <= 8; step++) {
      // Label each state by its visible prompt ("How old are you?", …); the h1
      // is a constant "Questionnaire", so pull the first meaningful heading.
      const prompt = await page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        return [...main.querySelectorAll("h1,h2,h3,legend")]
          .map((e) => e.textContent.replace(/\s+/g, " ").trim())
          .find(
            (t) =>
              t &&
              !/^questionnaire$/i.test(t) &&
              !/page footer|translate|adding activities/i.test(t)
          );
      });
      states.push(await captureState(page, `Questionnaire — ${prompt || `step ${step}`}`));

      const next = await handleByText(page, "button", "Continue");
      if (!next) break; // reached the final (location) step — no "Continue"
      await clickAndSettle(page, next, 1800);
    }

    // ④ Location step + results. Fill the neighborhood/zip search and accept the
    //    first autocomplete suggestion (ArrowDown+Enter) — that enables "See
    //    activities", which renders the activities map + list.
    const search = await page.$('input[type="search"]');
    if (search) {
      await search.click();
      await search.type("10007", { delay: 60 });
      await sleep(2000);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await sleep(1500);
    } else {
      console.log("     ! location search box not found — can't reach results");
    }
    const see = await handleByText(page, "button", "See activities");
    if (see) {
      await clickAndSettle(page, see, 4000);
      const h1 = await page.$eval("h1", (h) => h.textContent.trim()).catch(() => "?");
      console.log(`     → results state: "${h1}"`);
      states.push(await captureState(page, "Results — activities map + list"));

      // ⑤ Filters dialog — the "Filters" button opens a role="dialog" modal with
      //    its own form (select, search, checkboxes). Scan it, then Escape back
      //    to the results view so the next state starts clean.
      const filters = await handleByText(page, "button", "Filters");
      if (filters) {
        await clickAndSettle(page, filters, 1200);
        if (await page.$('[role="dialog"]')) {
          states.push(await captureState(page, "Results — filters dialog"));
          await page.keyboard.press("Escape");
          await sleep(800);
        } else {
          console.log('     ! "Filters" did not open a dialog — skipping that state');
        }
      } else {
        console.log('     ! "Filters" button not found — skipping that state');
      }

      // ⑥ Expanded activity — "View events near you" expands a result card inline
      //    (aria-expanded, ~2.5× the DOM), revealing event listings axe otherwise
      //    never sees on the collapsed list.
      const expand = await handleByText(page, "button", "View events near you");
      if (expand) {
        await clickAndSettle(page, expand, 1500);
        states.push(await captureState(page, "Results — expanded activity"));
      } else {
        console.log('     ! no "View events near you" card to expand — skipping');
      }
    } else {
      console.log('     ! "See activities" not enabled — results state not reached');
    }
  } catch (err) {
    console.log(`     ! Summer finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states);
}

// ---- driver ----------------------------------------------------------------

function parseArgs(argv) {
  const out = { only: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--only=")) out.only = a.slice("--only=".length);
  }
  return out;
}

async function main() {
  const { only } = parseArgs(process.argv);
  const all = JSON.parse(await readFile("sites.json", "utf8"));
  const apps = all.filter((s) => s.app && (!only || s.name === only));

  if (apps.length === 0) {
    console.error(
      only
        ? `No "app": true site named "${only}" in sites.json.`
        : `No "app": true sites in sites.json.`
    );
    process.exit(1);
  }

  console.log(
    `Driving ${apps.length} finder app(s) through their user-flow states, ` +
      `scanning each against WCAG 2.2 AA…\n`
  );

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    // The School Search SPA drives an ArcGIS map that can stall page evaluates
    // past Puppeteer's 30s default while it re-renders. Raise the protocol
    // timeout so axe calls survive heavy map updates.
    protocolTimeout: 120_000,
  });

  const results = [];
  for (const site of apps) {
    console.log(`  ${site.name} — ${site.url}`);
    // Dispatch by host: each app needs a different interaction flow.
    const host = new URL(site.url).hostname;
    let r;
    if (host.includes("a125-egovt")) r = await scanServiceFinder(browser, site);
    else if (host.includes("schoolsearch")) r = await scanSchoolSearch(browser, site);
    else if (host.includes("finder.nyc.gov")) r = await scanFoodHelpFinder(browser, site);
    else if (new URL(site.url).pathname.startsWith("/content/summer")) r = await scanSummerFinder(browser, site);
    else r = await scanActivitiesFinder(browser, site);
    console.log(
      `   ── ${r.tier.toUpperCase()} ${r.total_violations} issues / ` +
        `${r.distinct_rules} rules / ${r.pages.length} states scanned\n`
    );
    results.push(r);
  }

  await browser.close();

  // Append rule-level history for the freshly-scanned finders.
  {
    let history = [];
    try { history = JSON.parse(await readFile("history.json", "utf8")); } catch {}
    const date = new Date().toISOString();
    for (const site of results) {
      const byRule = {};
      for (const p of site.pages || []) {
        for (const v of p.violations || []) {
          if (!byRule[v.id]) byRule[v.id] = { id: v.id, impact: v.impact, count: 0 };
          byRule[v.id].count += v.nodes.length;
        }
      }
      history.push({ date, site: site.name, pages: site.pages.length, crawlComplete: true, rules: Object.values(byRule) });
    }
    await writeFile("history.json", JSON.stringify(history, null, 2) + "\n");
    const hjs = `// Auto-generated — do not edit by hand.\nwindow.HISTORY_DATA = ${JSON.stringify(history)};\n`;
    await writeFile("dashboard/history.js", hjs);
  }

  // Merge with prior results.json so the crawled sites are kept — same
  // contract as scan.js. Emitted in sites.json order.
  let prior = [];
  try {
    prior = JSON.parse(await readFile("results.json", "utf8")).sites ?? [];
  } catch {}
  const freshByName = new Map(results.map((r) => [r.name, r]));
  const priorByName = new Map(prior.map((r) => [r.name, r]));
  const mergedSites = all
    .map((s) => freshByName.get(s.name) ?? priorByName.get(s.name))
    .filter(Boolean);
  const cached = mergedSites.filter((s) => !freshByName.has(s.name)).map((s) => s.name);

  const payload = {
    scanned_at: new Date().toISOString(),
    wcag_target: "WCAG 2.2 AA",
    engine: "axe-core (via @axe-core/puppeteer)",
    sites: mergedSites,
  };

  const js = `// Auto-generated by scan-finders.mjs — do not edit by hand.\nwindow.SCAN_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  await writeFile("dashboard/results.js", js);
  await writeFile("results.json", JSON.stringify(payload, null, 2) + "\n");

  console.log(
    `Done. Scanned ${results.length} finder app(s) this run` +
      (cached.length ? `; kept cached: ${cached.join(", ")}` : "") + "."
  );
  const totalPages = mergedSites.reduce((sum, r) => sum + (r.pages?.length || 1), 0);
  console.log(`Wrote ${mergedSites.length} site(s) / ${totalPages} page(s) to dashboard/results.js and results.json.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
