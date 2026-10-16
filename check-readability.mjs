// check-readability.mjs — Score NYC311 help articles with two readability
// formulas and write the readability preview's data files.
//
// Usage:
//   node check-readability.mjs                    # every English article in the index → dashboard files
//   node check-readability.mjs --sample           # the articles in readability-articles.json (report only)
//   node check-readability.mjs --only=KA-02232,…  # specific articles (report only)
//   node check-readability.mjs --resume           # finish an interrupted full run
//   node check-readability.mjs --rescore          # re-score the published text with today's rules (no portal visits)
//
// Like check-links.mjs, this is deliberately separate from the accessibility
// scan. A readability score is a site-quality signal, NOT a WCAG conformance
// result (SC 3.1.5 is Level AAA, outside the 2.2 AA requirement) — it is never
// folded into the accessibility tiers, counts, or history.
//
// Only a complete full run writes the dashboard: a partial or aborted run
// would silently drop articles from it, so those write the report alone.
// Extraction and scoring rules live in readability-core.mjs.

import { readFile, writeFile, appendFile, readdir, unlink, mkdir } from "node:fs/promises";
import puppeteer from "puppeteer";
import {
  extractBlocks, scoreArticle, detailJs, agencyTerms, agencyNameMatcher, LONG_SENTENCE_WORDS, MIN_RELIABLE_WORDS,
} from "./readability-core.mjs";

const INDEX_URL = "https://portal.311.nyc.gov/all-articles/";
const ARTICLE_URL = "https://portal.311.nyc.gov/article/?kanumber=";
const SAMPLE_LIST = "readability-articles.json";
const OUT_JS = "dashboard/readability-data.js";
const OUT_DETAIL_DIR = "dashboard/readability";
const OUT_REPORT = "readability-results.json";

// The City's official list of agencies and offices (NYC Open Data, published
// by OTI), for the second ARI, which leaves agency names out. Each run fetches
// the current list and saves it; if the fetch fails, the saved copy is used.
const AGENCY_DATASET = "https://data.cityofnewyork.us/City-Government/NYC-Agencies-and-Governance-Organizations/t3jq-9nkf";
const AGENCY_API = "https://data.cityofnewyork.us/resource/t3jq-9nkf.json" +
  "?$select=name,acronym,alternate_or_former_names,alternate_or_former_acronyms&$order=name&$limit=5000";
const AGENCY_FILE = "readability-agency-names.json";
// Agency names the official list doesn't cover, kept by hand: State and
// federal agencies (each one's official name, acronym, and every other way
// the articles write it), and City names the articles write differently from
// the list. Left out of the second ARI along with the official list's names.
const EXTRA_AGENCY_FILE = "readability-agency-names-extra.json";

// The article body. Everything outside it — lookup modals, the survey popup,
// the "Was this information helpful?" form — is portal chrome.
const ROOT = "#knowledgearticle .ka-content";

// portal.311.nyc.gov is a production service portal, so: two tabs, a real gap
// between each tab's requests, one retry, and back off if errors pile up.
//
// Pages load as HTML + stylesheets only. The article text is server-rendered,
// and the stylesheets are what collapse the accordions; scripts, images, and
// fonts add nothing to extraction (verified: identical blocks on the sample
// with them blocked). Blocking them also avoids waiting on third-party script
// downloads, which sometimes delay the page's load event, and halves the load
// we put on the portal.
const BLOCKED_RESOURCES = new Set(["script", "image", "font", "media"]);
const TABS = 2;
const GAP_MS = 1000;
const TIMEOUT_MS = 45_000;
const RETRY_PAUSE_MS = 5000;
const ERROR_STREAK = 5; // consecutive failures before backing off
const BACKOFF_MS = 60_000;

const KA_RE = /^KA-\d+$/;

// Set once in main() from the agency lists; used by every scoreArticle() call.
let nameRe = null;

async function loadAgencyNames() {
  try {
    const res = await fetch(AGENCY_API, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const orgs = (await res.json()).map((o) => ({
      name: o.name ?? null,
      acronym: o.acronym ?? null,
      alternate_or_former_names: o.alternate_or_former_names ?? null,
      alternate_or_former_acronyms: o.alternate_or_former_acronyms ?? null,
    }));
    if (orgs.length < 100) throw new Error(`only ${orgs.length} organizations returned`);
    // No timestamp in the file, so an unchanged list rewrites it byte for byte.
    await writeFile(AGENCY_FILE, JSON.stringify({ source: AGENCY_DATASET, organizations: orgs }, null, 1) + "\n");
    console.log(`Agency names: ${orgs.length} organizations from NYC Open Data.`);
    return orgs;
  } catch (err) {
    console.error(`Agency names: couldn't fetch the list (${err.message}); using the copy saved in ${AGENCY_FILE}.`);
    return JSON.parse(await readFile(AGENCY_FILE, "utf8")).organizations;
  }
}

async function preparePage(browser, ua) {
  const page = await browser.newPage();
  await page.setUserAgent(ua);
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (req) => (BLOCKED_RESOURCES.has(req.resourceType()) ? req.abort() : req.continue()));
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const only = process.argv.find((a) => a.startsWith("--only="));
  return {
    only: only ? only.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : null,
    sample: process.argv.includes("--sample"),
    resume: process.argv.includes("--resume"),
    rescore: process.argv.includes("--rescore"),
  };
}

async function discover(page) {
  await page.goto(INDEX_URL, { waitUntil: "load", timeout: 90_000 });
  await page.waitForSelector("a[href*=kanumber]", { timeout: 30_000 });
  const links = await page.evaluate(() =>
    [...document.querySelectorAll("a[href*=kanumber]")].map((a) => ({
      ka: new URL(a.href).searchParams.get("kanumber"),
      title: a.textContent.replace(/\s+/g, " ").trim(),
    }))
  );
  const seen = new Map();
  for (const l of links) if (l.ka && KA_RE.test(l.ka) && !seen.has(l.ka)) seen.set(l.ka, l);
  return [...seen.values()];
}

async function scoreOne(page, ka) {
  const resp = await page.goto(ARTICLE_URL + ka, { waitUntil: "load", timeout: TIMEOUT_MS });
  if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
  await page.waitForSelector(ROOT, { timeout: 15_000 }).catch(() => {});
  const title = (await page.title()).replace(/\s*·\s*NYC311\s*$/, "").trim();
  const extracted = await page.evaluate(extractBlocks, ROOT);
  if (!extracted) throw new Error("article body not found on the page");
  return { title, ...scoreArticle(extracted.blocks, { nameRe }), unknown_hidden: extracted.unknownHidden };
}

// Chrome itself can die during a long run (~2,000 navigations). Those
// failures say nothing about the portal, so they're handled apart from it:
// relaunch the browser and retry, without counting toward the back-off.
const BROWSER_GONE = /Connection closed|Target closed|Session closed|detached|Protocol error|browser has disconnected/i;
const MAX_RELAUNCHES = 5;
const PAGE_RECYCLE = 100; // fresh tab every N articles, so one page never grows for an hour
const CHECKPOINT_EVERY = 100;

function launch() {
  return puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

// One shared browser; whoever finds it dead relaunches it (once, for everyone).
function browserPool(first) {
  let browser = first, launching = null, relaunches = 0;
  return {
    get relaunches() { return relaunches; },
    async get() {
      if (browser.connected) return browser;
      if (!launching) {
        relaunches++;
        console.error(`\n  browser closed unexpectedly — relaunching (${relaunches}/${MAX_RELAUNCHES})`);
        launching = launch().then((b) => { browser = b; launching = null; return b; });
      }
      return launching;
    },
    async close() { try { await browser.close(); } catch {} },
  };
}

// A small pool of tabs working through one queue. Each article gets one retry;
// a run of consecutive failures pauses everything once, and a second run
// aborts: if the portal is slow or unavailable, stop rather than add load.
// `onProgress` is called every CHECKPOINT_EVERY articles so a crash loses little.
async function scoreAll(pool, ua, targets, onProgress) {
  const results = new Map();
  let next = 0, done = 0, streak = 0, backedOff = false, aborted = false;
  let paused = null;

  const worker = async () => {
    let page = null, used = 0;
    const freshPage = async () => {
      try { await page?.close(); } catch {}
      page = await preparePage(await pool.get(), ua);
      used = 0;
    };

    while (!aborted && next < targets.length) {
      if (paused) await paused;
      const { ka, title } = targets[next++];
      let rec, portalTries = 0;
      while (!rec && !aborted) {
        try {
          if (!page || page.isClosed() || used >= PAGE_RECYCLE) await freshPage();
          used++;
          rec = await scoreOne(page, ka);
        } catch (err) {
          const msg = err.message.split("\n")[0];
          if (BROWSER_GONE.test(msg) || !(await pool.get().then((b) => b.connected).catch(() => false))) {
            if (pool.relaunches >= MAX_RELAUNCHES) {
              aborted = true;
              console.error(`\n  browser kept closing (${MAX_RELAUNCHES} relaunches) — stopping.`);
              break;
            }
            page = null; // next attempt gets a fresh tab in a live browser
            continue;
          }
          if (++portalTries < 2) {
            await sleep(RETRY_PAUSE_MS);
          } else {
            rec = { title, status: "error", reason: `Couldn't load the page (${msg}).` };
            console.error(`\n  couldn't load ${ka}: ${msg}`);
          }
        }
      }
      if (!rec) break; // aborted mid-article
      results.set(ka, { ka, url: ARTICLE_URL + ka, ...rec, title: rec.title || title });

      if (rec.status === "error") {
        streak++;
        if (streak >= ERROR_STREAK && !paused) {
          if (backedOff) {
            aborted = true;
            console.error(`\n${streak} failures in a row after backing off once — stopping.`);
          } else {
            backedOff = true;
            console.error(`\n${streak} failures in a row — pausing ${BACKOFF_MS / 1000}s.`);
            paused = sleep(BACKOFF_MS).then(() => { paused = null; streak = 0; });
          }
        }
      } else {
        streak = 0;
      }
      done++;
      if (done % 50 === 0 || done === targets.length) {
        process.stdout.write(`\r  scored ${done}/${targets.length}…`);
      }
      if (done % CHECKPOINT_EVERY === 0) await onProgress(results);
      await sleep(GAP_MS);
    }
    try { await page?.close(); } catch {}
  };

  await Promise.all(Array.from({ length: Math.min(TABS, targets.length) }, worker));
  process.stdout.write("\n");
  return { results, aborted };
}

// What a human should look at before the data is published.
function buildReport(articles, meta) {
  const by = (s) => articles.filter((a) => a.status === s || a.reason_code === s);
  const hidden = new Map();
  for (const a of articles) {
    for (const h of a.unknown_hidden || []) {
      const key = `${h.tag}${h.cls ? "." + h.cls.split(/\s+/).join(".") : ""}`;
      if (!hidden.has(key)) hidden.set(key, { pattern: key, count: 0, articles: [], sample: h.text });
      const g = hidden.get(key);
      g.count++;
      if (!g.articles.includes(a.ka) && g.articles.length < 10) g.articles.push(a.ka);
    }
  }
  const top = articles
    .filter((a) => a.status === "scored")
    .sort((x, y) => y.scores.ari - x.scores.ari)
    .slice(0, 20)
    .map((a) => ({ ka: a.ka, title: a.title, ari: a.scores.ari, fk_grade: a.scores.fk_grade, words: a.scores.words }));
  return {
    ...meta,
    errors: by("error").map((a) => ({ ka: a.ka, title: a.title, reason: a.reason })),
    no_prose: by("no-prose").map((a) => ({ ka: a.ka, title: a.title })),
    non_english: by("non-english").map((a) => ({ ka: a.ka, title: a.title })),
    unknown_hidden: [...hidden.values()].sort((x, y) => y.count - x.count),
    top_by_ari: top,
    articles,
  };
}

function printReport(r) {
  console.log(
    `\n${r.counts.scored} scored · ${r.counts.no_prose} no prose · ${r.counts.non_english} non-English (excluded) · ` +
      `${r.counts.error} couldn't load` + (r.aborted ? " · RUN ABORTED" : "")
  );
  for (const e of r.errors) console.log(`  couldn't load  ${e.ka}  ${e.title}  — ${e.reason}`);
  for (const e of r.no_prose) console.log(`  no prose       ${e.ka}  ${e.title}`);
  if (r.unknown_hidden.length) {
    console.log("\nHidden elements matching no known accordion pattern (review the extraction rules):");
    for (const h of r.unknown_hidden) console.log(`  ${h.count}× ${h.pattern}  e.g. ${h.articles.slice(0, 3).join(", ")}: ${h.sample}`);
  }
  console.log("\nHighest ARI (check these are real long-sentence articles, not extraction artifacts):");
  for (const t of r.top_by_ari) console.log(`  ${String(t.ari).padStart(5)}  ${t.ka}  ${t.words}w  ${t.title}`);
}

// The same review as Markdown on the GitHub Actions run page ("Job Summary"),
// so a scheduled run that publishes on its own still gets a human look.
async function writeStepSummary(r, published) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
  const link = (ka) => `[${ka}](${ARTICLE_URL}${ka})`;
  const L = [`## Readability refresh — ${r.checked_at.slice(0, 10)}`, ""];
  L.push(
    `${r.counts.scored} scored · ${r.counts.no_prose} no prose · ${r.counts.non_english} non-English (excluded) · ` +
      `${r.counts.error} couldn't load · ${r.minutes} min`,
    "",
    published ? "Dashboard files updated."
      : r.partial ? "Listed articles only — dashboard untouched."
      : "**Run incomplete — dashboard left unchanged.**",
    ""
  );
  if (r.errors.length) {
    L.push("### Couldn't load", "", "| Article | Title | Reason |", "|---|---|---|");
    for (const e of r.errors) L.push(`| ${link(e.ka)} | ${cell(e.title)} | ${cell(e.reason)} |`);
    L.push("");
  }
  if (r.no_prose.length) {
    L.push("### No prose", "");
    for (const e of r.no_prose) L.push(`- ${link(e.ka)} ${cell(e.title)}`);
    L.push("");
  }
  if (r.unknown_hidden.length) {
    L.push("### Hidden elements matching no known accordion pattern", "", "Review the extraction rules in `readability-core.mjs`.", "");
    L.push("| Count | Pattern | Examples | Sample text |", "|---|---|---|---|");
    for (const h of r.unknown_hidden) {
      L.push(`| ${h.count} | \`${cell(h.pattern)}\` | ${h.articles.slice(0, 3).map(link).join(", ")} | ${cell(h.sample)} |`);
    }
    L.push("");
  }
  if (r.top_by_ari.length) {
    L.push("### Highest ARI", "", "Check these are real long-sentence articles, not extraction artifacts.", "");
    L.push("| ARI | FK | Words | Article | Title |", "|---|---|---|---|---|");
    for (const t of r.top_by_ari) L.push(`| ${t.ari} | ${t.fk_grade} | ${t.words} | ${link(t.ka)} | ${cell(t.title)} |`);
  }
  await appendFile(file, L.join("\n") + "\n");
}

async function writeDashboard(articles, meta) {
  const summary = articles.map((a) => ({
    ka: a.ka,
    title: a.title,
    url: a.url,
    status: a.status,
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.scores ? { scores: a.scores, low_confidence: a.low_confidence } : {}),
  }));
  const payload = { ...meta, articles: summary };
  await writeFile(OUT_JS, `// Auto-generated by check-readability.mjs — do not edit by hand.\nwindow.READABILITY_DATA = ${JSON.stringify(payload, null, 1)};\n`);

  // One detail file per article. Failed loads keep last run's file, if any.
  await mkdir(OUT_DETAIL_DIR, { recursive: true });
  const keep = new Set();
  for (const a of articles) {
    keep.add(`${a.ka}.js`);
    if (a.status !== "error") await writeFile(`${OUT_DETAIL_DIR}/${a.ka}.js`, detailJs(a.ka, a));
  }
  // Articles that left the index (or stopped being English) lose their file.
  let removed = 0;
  for (const f of await readdir(OUT_DETAIL_DIR)) {
    if (f.endsWith(".js") && !keep.has(f)) { await unlink(`${OUT_DETAIL_DIR}/${f}`); removed++; }
  }
  console.log(`Wrote ${OUT_JS} and ${keep.size} detail file(s) in ${OUT_DETAIL_DIR}/` + (removed ? ` (removed ${removed} stale).` : "."));
}

// --rescore: apply rule changes in readability-core.mjs to the text the last
// full run published, without visiting the portal. The data keeps that run's
// date, since the text is from then. Articles that failed to load stay as they were.
async function rescore() {
  const src = await readFile(OUT_JS, "utf8");
  const { articles, ...meta } = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
  const out = [];
  for (const a of articles) {
    if (a.status === "error") { out.push(a); continue; }
    const d = await readFile(`${OUT_DETAIL_DIR}/${a.ka}.js`, "utf8");
    const { blocks, unknown_hidden } = JSON.parse(d.slice(d.indexOf("{"), d.lastIndexOf("}") + 1));
    out.push({ ka: a.ka, url: a.url, title: a.title, ...scoreArticle(blocks, { nameRe }), unknown_hidden });
  }
  console.log(`Re-scored ${out.length} articles from the text saved ${meta.checked_at}.`);
  await writeDashboard(out, meta);
}

async function main() {
  const args = parseArgs();
  const extra = JSON.parse(await readFile(EXTRA_AGENCY_FILE, "utf8")).agencies
    .flatMap((a) => [a.name, a.acronym, ...a.also_written]).filter(Boolean);
  nameRe = agencyNameMatcher([...agencyTerms(await loadAgencyNames()), ...extra]);
  if (args.rescore) return rescore();

  const first = await launch();
  // nyc.gov properties serve a different template to headless user agents;
  // present as regular Chrome, same as scan.js.
  const ua = (await first.userAgent()).replace("HeadlessChrome", "Chrome");
  const pool = browserPool(first);

  let targets;
  const partial = Boolean(args.only || args.sample);
  if (partial) {
    const list = args.only ?? JSON.parse(await readFile(SAMPLE_LIST, "utf8")).articles;
    targets = list.map((ka) => ({ ka, title: ka }));
    console.log(`Scoring ${targets.length} listed article(s) — report only, dashboard untouched…`);
  } else {
    const page = await preparePage(await pool.get(), ua);
    targets = await discover(page);
    await page.close();
    if (targets.length < 100) throw new Error(`Only ${targets.length} articles found on ${INDEX_URL} — the index page may have changed.`);
    console.log(`Found ${targets.length} articles in the index.`);
  }

  // --resume: reuse every article the last run's report already settled
  // (anything but a load error), and only visit the rest.
  const prior = new Map();
  if (args.resume) {
    try {
      const last = JSON.parse(await readFile(OUT_REPORT, "utf8"));
      // Re-score from the saved text, so rule changes in readability-core.mjs
      // apply without fetching the article again.
      for (const a of last.articles || []) {
        if (a.status === "error" || !a.blocks) continue;
        const { ka, url, title, unknown_hidden } = a;
        prior.set(ka, { ka, url, title, ...scoreArticle(a.blocks, { nameRe }), unknown_hidden });
      }
    } catch {
      console.log(`No ${OUT_REPORT} to resume from — starting fresh.`);
    }
  }
  const todo = targets.filter((t) => !prior.has(t.ka));
  if (prior.size) console.log(`Resuming: ${targets.length - todo.length} already scored, ${todo.length} to go.`);
  console.log(`Scoring ${todo.length} article(s) with ${TABS} tabs…`);

  const started = Date.now();
  const assemble = (results) =>
    targets.map((t) => results.get(t.ka) ?? prior.get(t.ka)).filter(Boolean);
  const metaFor = (all) => {
    const count = (f) => all.filter(f).length;
    return {
      checked_at: new Date().toISOString(),
      source: INDEX_URL,
      long_sentence_words: LONG_SENTENCE_WORDS,
      min_reliable_words: MIN_RELIABLE_WORDS,
      excluded_non_english: count((a) => a.reason_code === "non-english"),
      counts: {
        scored: count((a) => a.status === "scored"),
        no_prose: count((a) => a.reason_code === "no-prose"),
        non_english: count((a) => a.reason_code === "non-english"),
        error: count((a) => a.status === "error"),
      },
    };
  };
  const minutes = () => Math.round((Date.now() - started) / 6000) / 10;
  const checkpoint = async (results) => {
    const all = assemble(results);
    const report = buildReport(all, { ...metaFor(all), partial: true, in_progress: true, minutes: minutes() });
    await writeFile(OUT_REPORT, JSON.stringify(report) + "\n");
  };

  const { results, aborted } = await scoreAll(pool, ua, todo, checkpoint);
  await pool.close();

  // Keep index order; drop non-English articles from the published data.
  const all = assemble(results);
  const english = all.filter((a) => a.reason_code !== "non-english");
  const meta = metaFor(all);
  const complete = !aborted && all.length === targets.length;

  const report = buildReport(all, { ...meta, partial, aborted, minutes: minutes() });
  await writeFile(OUT_REPORT, JSON.stringify(report) + "\n");
  printReport(report);
  await writeStepSummary(report, complete && !partial);
  console.log(`\nWrote ${OUT_REPORT} (${report.minutes} min this run).`);

  if (!complete) {
    console.error("Run incomplete — dashboard left unchanged. Rerun with --resume to finish.");
    process.exit(1);
  }
  if (!partial) {
    const { counts, ...publicMeta } = meta;
    await writeDashboard(english, { ...publicMeta, total_in_index: targets.length });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
