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
// Scoring and measurement are imported, never redefined here. This file used to
// carry its own copies under a "keep in sync" comment and they drifted — its
// tierFor graded a serious-but-not-critical site RED where scan.js graded the
// same counts ORANGE. See scan-core.mjs.
import {
  WCAG_TAGS,
  sleep,
  settlePage,
  tagEmbeds,
  pageEmbeds,
  countedTotal,
  countedRules,
  embedTotal,
  tierFor,
  countByImpact,
  addCounts,
  emptyCounts,
  rulesForHistory,
  mergeSitesWithPrior,
  slimViolations,
  compileSuppressions,
  tagSuppressions,
  suppressedTotal,
  EXCLUDED_EMBEDS,
} from "./scan-core.mjs";

// Compiled suppressions.json, loaded once in main(). Null means no file, which
// is the normal state. Same contract as scan.js — see scan-core.mjs.
let SUPPRESSIONS = null;

// ---- state capture ---------------------------------------------------------

// Run axe on the page's CURRENT (post-interaction) DOM and return a record
// shaped like a scan.js "page", plus a human `label` for the state — a postback
// app / SPA has no distinct URL per state for the dashboard to show.
// Read the marker that identifies which state we are actually looking at. The
// h1 is what changes between a finder's steps, so it is the cheapest honest
// answer to "is this the screen we think it is".
async function stateMarker(page) {
  return page
    .$eval("h1", (h) => h.textContent.replace(/\s+/g, " ").trim())
    .catch(() => "");
}

// Poll until the expected state is on screen. Interaction-driven apps have no
// navigation to await — the URL never changes — so the alternative is a fixed
// sleep, and a fixed sleep is how we ended up scanning a questionnaire step and
// labelling it "Results".
async function waitForState(page, expect, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    if (expect.h1) {
      last = await stateMarker(page);
      if (expect.h1.test(last)) return { ok: true, marker: last };
    }
    if (expect.selector) {
      const found = await page.$(expect.selector);
      if (found) return { ok: true, marker: await stateMarker(page) };
    }
    // For apps whose h1 never changes between screens (Food Help Finder's is
    // always "Food Help"), the route is what identifies the screen.
    if (expect.path && new URL(page.url()).pathname === expect.path) {
      return { ok: true, marker: await stateMarker(page) };
    }
    if (expect.button && (await handleByText(page, "button", expect.button))) {
      return { ok: true, marker: await stateMarker(page) };
    }
    if (Date.now() > deadline) {
      return {
        ok: false,
        marker: last,
        why: expect.h1
          ? `expected h1 matching ${expect.h1}, saw "${last}"`
          : expect.path
          ? `expected to be at ${expect.path}, was at ${new URL(page.url()).pathname}`
          : expect.button
          ? `expected a "${expect.button}" button, none appeared`
          : `expected an element matching ${expect.selector}, none appeared`,
      };
    }
    await sleep(400);
  }
}

// Wait for an element to disappear. Closing a modal is not instantaneous, and
// clickAndSettle swallows click failures — so without this, the next click
// lands on a still-open overlay and the state after it is silently wrong.
async function waitForGone(page, selector, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await page.$(selector))) return true;
    await sleep(300);
  }
  return false;
}

// `expect` (optional) asserts WHICH screen this is before axe runs. Without it
// a flow that silently fails to advance produces a clean scan of the previous
// screen — which reads as a pass and hides both the missing coverage and
// whatever the real screen would have reported. A state that cannot be
// confirmed is recorded as an ERROR, never as a result.
async function captureState(page, label, expect = null) {
  const start = Date.now();
  try {
    if (expect) {
      const seen = await waitForState(page, expect);
      if (!seen.ok) {
        console.log(`     ✗ ${label.padEnd(36)} STATE NOT REACHED — ${seen.why}`);
        return errorState(page, label, `State not reached: ${seen.why}`, start);
      }
    }
    // Settle first, exactly as scan.js does: a finder's results list can lazy-
    // load rows below the fold, and scanning them in their placeholder state
    // reports findings no user ever meets.
    await settlePage(page);
    const result = await new AxePuppeteer(page).withTags(WCAG_TAGS).analyze();
    const violations = await tagEmbeds(page, slimViolations(result.violations));
    tagSuppressions(violations, page.url(), SUPPRESSIONS);
    const embeds = await pageEmbeds(page);
    // countByImpact reads the embed tags, so counts must come from the tagged
    // slim violations — not from the raw axe result, which has no tags.
    const counts = countByImpact(violations);
    const rec = {
      url: page.url(),
      final_url: page.url(),
      label,
      // Recorded on every state, asserted or not: if a flow ever mislabels a
      // screen again, the evidence is in results.json instead of nowhere.
      state_marker: await stateMarker(page),
      tier: tierFor(counts),
      counts,
      total_violations: countedTotal(violations),
      distinct_rules: countedRules(violations).length,
      embed_violations: embedTotal(violations),
      suppressed_violations: suppressedTotal(violations),
      embeds,
      violations,
      scan_ms: Date.now() - start,
      error: null,
    };
    console.log(`     ✓ ${label.padEnd(36)} ${rec.tier.toUpperCase().padEnd(6)} ${rec.total_violations} issues`);
    return rec;
  } catch (err) {
    console.log(`     ✗ ${label.padEnd(36)} ERROR ${err.message}`);
    return errorState(page, label, err.message, start);
  }
}

// A state we could not scan has no result — clean or otherwise. Shaped exactly
// like a captured state so assembleSite and the dashboard need no special case.
function errorState(page, label, message, start) {
  return {
    url: page.url(),
    final_url: page.url(),
    label,
    tier: "error",
    counts: emptyCounts(),
    total_violations: 0,
    distinct_rules: 0,
    embed_violations: 0,
    suppressed_violations: 0,
    embeds: [],
    violations: [],
    scan_ms: Date.now() - start,
    error: message,
  };
}

// A step of the scripted walk that did not happen. A skipped state leaves no
// page behind, so without a record the site simply reads as smaller — and,
// when the skipped screen was the one with findings, cleaner. Recorded on the
// site so the dashboard can say the scan was incomplete.
function flowGap(gaps, message) {
  console.log(`     ! ${message}`);
  gaps.push(message);
}

// Roll per-state records up into a scan.js-shaped site object. A state that
// was attempted but not scanned — the screen was not the one expected, or axe
// failed on it — is a gap too: that screen went unchecked just the same as one
// the walk never reached.
function assembleSite(site, states, skipped) {
  const gaps = [
    ...skipped,
    ...states.filter((s) => s.error).map((s) => `${s.label}: ${s.error}`),
  ];
  const counts = states.reduce((acc, s) => addCounts(acc, s.counts), emptyCounts());
  return {
    name: site.name,
    url: site.url,
    scanned_at: new Date().toISOString(),
    tier: tierFor(counts),
    counts,
    total_violations: states.reduce((s, p) => s + p.total_violations, 0),
    distinct_rules: new Set(
      states.flatMap((p) => countedRules(p.violations).map((v) => v.id))
    ).size,
    embed_violations: states.reduce((sum, p) => sum + (p.embed_violations ?? 0), 0),
    suppressed_violations: states.reduce((sum, p) => sum + (p.suppressed_violations ?? 0), 0),
    embed_vendors: [...new Set(states.flatMap((p) => (p.embeds ?? []).map((e) => e.vendor)))],
    pages: states,
    scan_ms: states.reduce((s, p) => s + p.scan_ms, 0),
    error: states.length > 0 && states.every((p) => p.error) ? states[0].error : null,
    crawlComplete: true,
    flow_gaps: gaps,
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
  const gaps = [];
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
      flowGap(gaps, `"${browseFor}" quick-link not found — skipping results state`);
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
      flowGap(gaps, "no service-detail link found on results page");
    }
  } catch (err) {
    flowGap(gaps, `Service Finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states, gaps);
}

// ---- DOE School Search: React SPA atop ArcGIS map --------------------------

async function scanSchoolSearch(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  const gaps = [];
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
      flowGap(gaps, "Schools tab not found — skipping list state");
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
        flowGap(gaps, "filters submit not found");
      }
    } catch (err) {
      flowGap(gaps, `filter flow error: ${err.message}`);
    }
  } catch (err) {
    flowGap(gaps, `School Search flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states, gaps);
}

// ---- Food Help Finder: ArcGIS map + React sidebar at finder.nyc.gov -------

async function scanFoodHelpFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  const gaps = [];
  try {
    // ① Landing — map + sidebar with "What is Food Help NYC?" content.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(4000); // ArcGIS map needs a beat to settle
    states.push(
      await captureState(page, "Landing — map + intro", { path: "/foodhelp/" })
    );

    // ② Locations list — typing an address + Enter routes to /foodhelp/locations
    //    with a real list of nearby pantries/kitchens. The Esri autocomplete
    //    accepts free-text + Enter without needing a suggestion click. Its
    //    <input> lives in the shadow root of a <calcite-autocomplete> (the Search
    //    widget moved to Calcite components between the 2026-09-04 and
    //    2026-09-11 scans, which broke the old #searchDiv-input selector), so
    //    the lookup has to pierce it.
    const term = "Times Square, Manhattan";
    const box = await page.$("#searchDiv calcite-autocomplete >>> input");
    if (box) {
      await box.click({ clickCount: 3 });
      await box.type(term, { delay: 30 });
      await sleep(1200);
      await page.keyboard.press("Enter");
      await sleep(5000);
      console.log(`     → searched "${term}", url now: ${page.url()}`);
      states.push(
        await captureState(page, `Locations near "${term}"`, { path: "/foodhelp/locations" })
      );
    } else {
      flowGap(gaps, "address search box not found — skipping locations state");
    }
  } catch (err) {
    flowGap(gaps, `Food Help Finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states, gaps);
}

// ---- Activities Finder: React SPA, content renders client-side -------------

async function scanActivitiesFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const states = [];
  const gaps = [];
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
      flowGap(gaps, "search box not found — skipping search state");
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
      flowGap(gaps, "no event-detail link found");
    }
  } catch (err) {
    flowGap(gaps, `Activities Finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states, gaps);
}

// ---- Summer in NYC: client-side questionnaire wizard → activities map ------
// "Get Started" opens an in-place SPA questionnaire (age slider, audience
// radios, interest checkboxes, neighborhood search) that keeps the same URL for
// every step, so a link crawl only ever sees the splash screen. We click
// through and run axe at each state. The final "See activities" stays disabled
// until the location field is filled from its autocomplete, which then reveals
// the results map + activity list — the app's real payload.
// The results view's own heading. Everything before it — splash and every
// questionnaire step — renders under a constant "Questionnaire" h1, so this is
// what distinguishes "we reached the activities map" from "we are still in the
// wizard and about to record it as a clean results scan".
const RESULTS_H1 = /Activities for You/i;

async function scanSummerFinder(browser, site) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // www.nyc.gov's WAF serves "Access Denied" to a stock HeadlessChrome agent,
  // which leaves no splash and no logo to reset with. Mask it the same way
  // scan.js does so we get the real app.
  await page.setUserAgent((await browser.userAgent()).replace("HeadlessChrome", "Chrome"));
  const states = [];
  const gaps = [];
  try {
    // ① Splash — the marketing landing state, before the wizard opens.
    //    Once the screener has been completed, the app remembers and opens
    //    straight to the activities map, so the splash (and every wizard step)
    //    is unreachable by clicking forward. Its own logo — a button, NOT the
    //    global nyc.gov logo above it, which navigates away — resets to the
    //    screener, so click that whenever we don't land on the splash.
    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await sleep(1500);
    if (!(await handleByText(page, "button", "Get Started"))) {
      const logo = await page.$('button[aria-label="Go to home page"]');
      if (logo) {
        console.log("     · opened to the map (screener remembered) — resetting via the logo");
        await clickAndSettle(page, logo, 2500);
      } else {
        flowGap(gaps, "not on the splash and no logo button to reset with");
      }
    }
    states.push(
      await captureState(page, "Splash — landing", { button: "Get Started" })
    );

    // ② Open the wizard. "Get Started" is a <button> with an onclick handler
    //    (no href / navigation), so the URL never changes from here on.
    const start = await handleByText(page, "button", "Get Started");
    if (!start) {
      flowGap(gaps, '"Get Started" not found — only the splash was scanned');
      return assembleSite(site, states, gaps);
    }
    await clickAndSettle(page, start, 1800);

    // ③ Walk the questionnaire. Each step advances on "Continue" (which works
    //    on the wizard's defaults); the final location step swaps that button
    //    for "See activities". Cap the loop so a UI change can't spin forever.
    let prevPrompt = null;
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
      // Every step shares the h1 and the URL, so the only sign that "Continue"
      // did nothing is seeing the same question twice.
      if (prompt && prompt === prevPrompt) {
        flowGap(gaps, `"Continue" did not advance past "${prompt}" — later questionnaire steps not scanned`);
        break;
      }
      prevPrompt = prompt;
      states.push(
        await captureState(page, `Questionnaire — ${prompt || `step ${step}`}`, { h1: /^Questionnaire$/i })
      );

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
      flowGap(gaps, "location search box not found — can't reach results");
    }
    const see = await handleByText(page, "button", "See activities");
    if (see) {
      // No navigation to await — "See activities" swaps the view in place — so
      // the results state is identified by its own h1 rather than by a timer.
      // A fixed sleep here previously captured the questionnaire step and
      // recorded it as a clean "Results" scan.
      await clickAndSettle(page, see, 1500);
      states.push(
        await captureState(page, "Results — activities map + list", { h1: RESULTS_H1 })
      );

      // ⑤ Filters dialog — the "Filters" button opens a role="dialog" modal with
      //    its own form (select, search, checkboxes). Scan it, then Escape back
      //    to the results view so the next state starts clean.
      // The button is labelled "Filter activities". It was "Filters" when this
      // flow was written, and the exact-match lookup silently skipped the state
      // for however long ago it was renamed — hence both spellings, and hence
      // the louder message when neither is found.
      const filters =
        (await handleByText(page, "button", "Filter activities")) ||
        (await handleByText(page, "button", "Filters"));
      if (filters) {
        await clickAndSettle(page, filters, 1200);
        states.push(
          await captureState(page, "Results — filters dialog", {
            selector: '[role="dialog"]',
          })
        );
        await page.keyboard.press("Escape");
        if (!(await waitForGone(page, '[role="dialog"]'))) {
          flowGap(gaps,
            "filters dialog did not close — later states would be scanned behind it"
          );
        }
      } else {
        flowGap(gaps,
          'no "Filter activities" / "Filters" button — the filters state was NOT scanned'
        );
      }

      // ⑥ Expanded activity — "View events near you" expands a result card inline
      //    (aria-expanded, ~2.5× the DOM), revealing event listings axe otherwise
      //    never sees on the collapsed list.
      const expand = await handleByText(page, "button", "View events near you");
      if (expand) {
        await clickAndSettle(page, expand, 1500);
        states.push(
          await captureState(page, "Results — expanded activity", {
            selector: '[aria-expanded="true"]',
          })
        );
      } else {
        flowGap(gaps,
          'no "View events near you" card — the expanded state was NOT scanned'
        );
      }
    } else {
      flowGap(gaps, '"See activities" not enabled — results state not reached');
    }
  } catch (err) {
    flowGap(gaps, `Summer finder flow error: ${err.message}`);
  } finally {
    await page.close();
  }
  return assembleSite(site, states, gaps);
}

// ---- driver ----------------------------------------------------------------

function parseArgs(argv) {
  const out = { only: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--only=")) out.only = a.slice("--only=".length);
  }
  return out;
}

// Same loader contract as scan.js: missing file is normal, malformed is fatal.
async function loadSuppressions() {
  let raw;
  try {
    raw = JSON.parse(await readFile("suppressions.json", "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`suppressions.json could not be read: ${err.message}`);
  }
  return compileSuppressions(raw);
}

async function main() {
  const { only } = parseArgs(process.argv);
  SUPPRESSIONS = await loadSuppressions();
  const all = JSON.parse(await readFile("sites.json", "utf8"));
  // Same retirement contract as scan.js: skipped by default, still reachable
  // with --only= if a retired app is ever brought back.
  const apps = all.filter((s) => s.app && (only ? s.name === only : !s.retired));

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
        `${r.distinct_rules} rules / ${r.pages.length} states scanned` +
        (r.flow_gaps.length ? ` — INCOMPLETE, ${r.flow_gaps.length} step(s) skipped` : "") +
        "\n"
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
      history.push({
        date,
        site: site.name,
        pages: site.pages.length,
        crawlComplete: true,
        // Same configuration keys scan.js records, so the trend chart can mark
        // a methodology change on a finder the same way it does on a crawled
        // site. No `viewports` key: this scanner is desktop-only, and entries
        // without the key already read as desktop-only.
        settled: true,
        excludedEmbeds: EXCLUDED_EMBEDS.map((e) => e.vendor),
        rules: rulesForHistory(site.pages || []),
      });
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
  const mergedSites = mergeSitesWithPrior(all, results, prior);
  const scannedNames = new Set(results.map((r) => r.name));
  const cached = mergedSites.filter((s) => !scannedNames.has(s.name)).map((s) => s.name);

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

  // A broken walk still exits 0 — the states it did reach are real results —
  // but in Actions it surfaces as a warning annotation on the run summary
  // rather than a line in a 2-hour log.
  const incomplete = results.filter((r) => r.flow_gaps.length);
  if (incomplete.length) {
    console.log(`\nIncomplete finder scans (a site changed, or a flow step needs updating):`);
    for (const r of incomplete) {
      for (const g of r.flow_gaps) {
        console.log(`  ${r.name}: ${g}`);
        if (process.env.GITHUB_ACTIONS) {
          console.log(`::warning title=Incomplete scan: ${r.name}::${g.replace(/\r?\n/g, " ")}`);
        }
      }
    }
  }
}

// Guarded the same way scan.js is, so importing this module — from a test, or
// to reuse a flow — does not launch a browser and overwrite results.json.
if (process.argv[1]?.endsWith("scan-finders.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
