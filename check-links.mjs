// check-links.mjs — Validate the links collected by `scan.js --collect-links`
// and write the broken-link dashboard's data file.
//
// Usage:
//   node scan.js --only=OTI --collect-links   # produces link-manifest.json
//   node check-links.mjs                       # produces dashboard/links-data.js
//
// This is deliberately separate from the accessibility scan. Broken links are a
// site-quality signal, NOT a WCAG conformance issue — they are never folded into
// the accessibility tiers or counts. Output mirrors axe's honest "needs review"
// pattern: every link is sorted into one of three lanes —
//   ok      — final status 2xx/3xx
//   broken  — confirmed dead (4xx, persistent 5xx, DNS/connection failure)
//   review  — could not be verified (429/403/401 rate-limit or bot-wall,
//             timeouts, TLS errors). NOT counted as broken — flagged for a human.

import { readFile, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";

const MANIFEST = "link-manifest.json";
const OUT_JS = "dashboard/links-data.js";
const OUT_JSON = "link-results.json";

// Throttling. nyc.gov (and most agency sites) sit behind a WAF that 403s
// sustained requests from one client — and since an OTI scan is mostly nyc.gov
// links, a flat pool trips it and then 403s *everything* for a cooldown. So we
// cap concurrency PER HOST with a real minimum gap, and parallelise across the
// long tail of distinct hosts. Empirically (OTI), 2/host + ~300ms holds nyc.gov
// at 200s with zero 403s; faster trips the WAF. A transient 403/429/timeout
// still gets one retry after a pause.
const HOST_POOL = 12; // distinct hosts processed at once
const PER_HOST = 2; // concurrent requests to any single host
const HOST_GAP_MS = 300; // minimum pause between requests to the same host
const RETRY_PAUSE_MS = 3000;
const TIMEOUT_MS = 10_000;
// Present as a normal desktop browser. The WAFs on *.nyc.gov blanket-403
// non-browser clients under load, so an "honest" custom UA makes the tool
// 403 our own City's links. scan.js does the same (it de-headlesses Chrome's
// UA) for the same reason; we compensate by being polite (the throttling above).
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
// Cap the per-link list of source pages so a footer link shared by hundreds of
// pages doesn't bloat the output; we keep a count alongside the sample.
const MAX_SOURCE_PAGES = 25;

const MAX_REDIRECTS = 10;

// One HTTP attempt, following redirects MANUALLY so we can carry a cookie jar
// across hops. Many government/WAF sites set a cookie and redirect to the same
// URL to check it — a cookieless client (Node fetch's default redirect:follow
// keeps no cookies) loops forever and looks "dead" when it works fine in a
// browser. We accumulate Set-Cookie like a browser, so those resolve correctly.
// Returns { status, finalUrl, errCode }; status 0 means it never completed.
async function request(href, method) {
  const jar = new Map(); // cookie name -> value, for this redirect chain
  let url = href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      const headers = { ...BROWSER_HEADERS };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      res = await fetch(url, { method, redirect: "manual", signal: ctrl.signal, headers });
    } catch (err) {
      let code = "NETWORK";
      if (err.name === "AbortError") code = "TIMEOUT";
      else if (err.cause?.code) code = err.cause.code;
      return { status: 0, finalUrl: url, errCode: code };
    } finally {
      clearTimeout(timer);
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) jar.set(m[1].trim(), m[2]);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      try { await res.arrayBuffer(); } catch {} // drain before next hop
      try { url = new URL(loc, url).href; } catch { return { status: res.status, finalUrl: url, errCode: null }; }
      continue;
    }
    if (method === "GET") { try { await res.arrayBuffer(); } catch {} }
    return { status: res.status, finalUrl: url, errCode: null };
  }
  return { status: 0, finalUrl: url, errCode: "REDIRECT_LOOP" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hostOf = (href) => {
  try { return new URL(href).host; } catch { return href; }
};

// A 403/429/timeout under WAF throttling is usually transient, not a dead link —
// worth one retry rather than dumping it straight into "needs review".
function isTransient(status, errCode) {
  if (errCode === "TIMEOUT") return true;
  return [403, 408, 429, 503].includes(status);
}

// HEAD first (cheap); fall back to GET when the server rejects HEAD (405/501) or
// the HEAD attempt errored — many hosts mishandle HEAD or only bot-wall it. One
// extra GET retry after a pause for transient throttling.
async function checkOne(href) {
  let res = await request(href, "HEAD");
  if (res.status === 405 || res.status === 501 || res.errCode) {
    res = await request(href, "GET");
  }
  if (isTransient(res.status, res.errCode)) {
    await sleep(RETRY_PAUSE_MS);
    res = await request(href, "GET");
  }
  return res;
}

// Hosts that block automated checking regardless of whether the link is valid
// (social platforms 400/403/login-wall every bot). A non-OK result from these
// means "couldn't verify", never "broken" — otherwise every Facebook link in a
// footer reads as a dead link.
const UNVERIFIABLE_HOSTS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "tiktok.com",
];
function isUnverifiable(href) {
  let host;
  try { host = new URL(href).host.toLowerCase(); } catch { return false; }
  return UNVERIFIABLE_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

// Social "share this page" buttons — not outbound links. One gets stamped on
// every page, so without this they dominate the report (40+ Facebook sharers
// on OTI alone) while telling us nothing about link health.
const SHARE_WIDGET =
  /(facebook\.com\/sharer|facebook\.com\/dialog\/share|twitter\.com\/intent|x\.com\/intent|linkedin\.com\/(shareArticle|sharing)|pinterest\.com\/pin\/create|reddit\.com\/submit|t\.me\/share|(wa\.me|api\.whatsapp\.com)\/)/i;
function isShareWidget(href) {
  return SHARE_WIDGET.test(href);
}

// Be conservative about "broken": an automated, cookieless, non-browser client
// can't reliably tell a dead link from one that's bot-blocked, needs cookies, or
// wants a signed/interactive request. So we only call something broken on
// HIGH-CONFIDENCE signals — 404/410 (the server itself says "gone") or a domain
// that doesn't resolve at all. Everything else is "needs review", not broken.
// A false "broken" costs trust; a false "needs review" just costs a human glance.
function classify(href, status, errCode) {
  if (!errCode && status >= 200 && status < 400) return "ok";
  if (isUnverifiable(href)) return "review"; // social/bot-hostile: can't confirm
  if (errCode) {
    if (errCode === "ENOTFOUND") return "broken"; // domain doesn't resolve — truly dead
    return "review"; // TIMEOUT, REDIRECT_LOOP, TLS, ECONNREFUSED, … — can't confirm
  }
  if (status === 404 || status === 410) return "broken"; // server says it's gone
  return "review"; // other 4xx/5xx — bot-block / quirk, not confirmed dead
}

// Second pass: re-verify links still in "needs review" with a real browser.
// The fetch pass can't beat TLS-fingerprint WAFs (Cloudflare/Akamai) that 403
// any non-browser client regardless of headers — but real Chrome passes. We only
// re-check the handful that landed in review (skipping unverifiable social hosts,
// which a browser can't settle either), so this stays cheap. Mutates `result`.
async function browserReverify(result) {
  const targets = [...result]
    .filter(([href, r]) => r.state === "review" && !isUnverifiable(href))
    .map(([href]) => href);
  if (!targets.length) return;

  console.log(`Re-verifying ${targets.length} blocked link(s) with a real browser…`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ua = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
  let recovered = 0;
  for (const href of targets) {
    const page = await browser.newPage();
    try {
      await page.setUserAgent(ua);
      const resp = await page.goto(href, { waitUntil: "domcontentloaded", timeout: 25_000 });
      const status = resp ? resp.status() : 0;
      const r = result.get(href);
      r.status = status;
      r.finalUrl = page.url();
      r.errCode = null;
      r.via = "browser";
      const newState = classify(href, status, null);
      if (newState !== "review") recovered++;
      r.state = newState;
    } catch {
      result.get(href).via = "browser"; // tried in a browser, still couldn't load — stays review
    } finally {
      await page.close();
    }
  }
  await browser.close();
  console.log(`  browser pass resolved ${recovered}/${targets.length}.`);
}

// Host-aware scheduler: group URLs by host, process up to HOST_POOL hosts at
// once, and within each host run at most PER_HOST concurrent requests with a
// jittered gap. This keeps us from bursting any single WAF while still
// parallelising across the long tail of distinct external hosts. Returns a
// Map<href, result>.
async function checkAll(hrefs, fn) {
  const byHost = new Map();
  for (const href of hrefs) {
    const h = hostOf(href);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(href);
  }
  const out = new Map();
  const total = hrefs.length;
  let done = 0;

  const processHost = async (list) => {
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const href = list[i++];
        await sleep(HOST_GAP_MS + Math.random() * 100); // real gap + jitter, per host
        out.set(href, await fn(href));
        done++;
        if (done % 50 === 0 || done === total) {
          process.stdout.write(`\r  checked ${done}/${total} URLs…`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PER_HOST, list.length) }, worker));
  };

  const hosts = [...byHost.values()];
  let hi = 0;
  const hostWorker = async () => {
    while (hi < hosts.length) await processHost(hosts[hi++]);
  };
  await Promise.all(Array.from({ length: Math.min(HOST_POOL, hosts.length) }, hostWorker));
  process.stdout.write("\n");
  return out;
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    console.error(
      `Could not read ${MANIFEST}. Run a scan with --collect-links first, e.g.:\n` +
        `  node scan.js --only=OTI --collect-links`
    );
    process.exit(1);
  }

  // Gather every unique href across all sites/pages, remembering which site+page
  // each one was seen on (and the first non-empty anchor text and its kind).
  // Share-widget URLs (the "share to Facebook/X/LinkedIn" buttons stamped on
  // every page) are skipped — they're interface chrome, not outbound links to
  // verify, and otherwise flood the report with one entry per page.
  let skipped = 0;
  const urls = new Map(); // href -> { kind, text, bySite: Map<siteName, Set<pageUrl>> }
  for (const site of manifest.sites) {
    for (const page of site.pages) {
      for (const link of page.links) {
        if (isShareWidget(link.href)) { skipped++; continue; }
        let rec = urls.get(link.href);
        if (!rec) {
          rec = { kind: link.kind, text: link.text || "", bySite: new Map() };
          urls.set(link.href, rec);
        }
        if (!rec.text && link.text) rec.text = link.text;
        if (!rec.bySite.has(site.name)) rec.bySite.set(site.name, new Set());
        rec.bySite.get(site.name).add(page.url);
      }
    }
  }

  const hrefs = [...urls.keys()];
  const hostCount = new Set(hrefs.map(hostOf)).size;
  console.log(
    `Checking ${hrefs.length} unique URL(s) across ${hostCount} host(s) from ` +
      `${manifest.sites.length} site(s) (≤${PER_HOST}/host, ${TIMEOUT_MS / 1000}s timeout` +
      (skipped ? `; skipped ${skipped} share-widget link(s)` : "") + ")…"
  );

  const checked = await checkAll(hrefs, checkOne); // Map<href, {status,finalUrl,errCode}>
  const result = new Map(); // href -> { status, state, finalUrl, errCode, via? }
  for (const [href, { status, finalUrl, errCode }] of checked) {
    result.set(href, { status, finalUrl, errCode, state: classify(href, status, errCode) });
  }

  await browserReverify(result);

  // Re-assemble per site: one entry per unique href on that site, with the
  // pages that link to it. Sorted broken → review → ok for the dashboard.
  const order = { broken: 0, review: 1, ok: 2 };
  const sites = manifest.sites.map((site) => {
    const links = [];
    const counts = { ok: 0, review: 0, broken: 0 };
    for (const [href, rec] of urls) {
      const pageSet = rec.bySite.get(site.name);
      if (!pageSet) continue; // this URL wasn't linked from this site
      const r = result.get(href);
      counts[r.state]++;
      // Only the broken/review lanes are ever displayed. Storing every OK link
      // would bloat this published file and needlessly surface full query
      // strings (tracking params, tokens, embedded addresses). Keep counts for
      // OK; keep details only for the links a human needs to look at.
      if (r.state === "ok") continue;
      const pages = [...pageSet];
      links.push({
        href,
        text: rec.text,
        kind: rec.kind,
        status: r.status,
        state: r.state,
        ...(r.finalUrl !== href ? { redirected_to: r.finalUrl } : {}),
        ...(r.errCode ? { error: r.errCode } : {}),
        ...(r.via ? { via: r.via } : {}),
        page_count: pages.length,
        pages: pages.slice(0, MAX_SOURCE_PAGES),
      });
    }
    links.sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        a.status - b.status ||
        a.href.localeCompare(b.href)
    );
    return { name: site.name, url: site.url, counts, links };
  });

  const payload = {
    checked_at: new Date().toISOString(),
    collected_at: manifest.collected_at ?? null,
    timeout_ms: TIMEOUT_MS,
    total_urls: hrefs.length,
    sites,
  };

  const js = `// Auto-generated by check-links.mjs — do not edit by hand.\nwindow.LINKS_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  await writeFile(OUT_JS, js);
  await writeFile(OUT_JSON, JSON.stringify(payload, null, 2) + "\n");

  const tot = sites.reduce(
    (a, s) => ({
      ok: a.ok + s.counts.ok,
      review: a.review + s.counts.review,
      broken: a.broken + s.counts.broken,
    }),
    { ok: 0, review: 0, broken: 0 }
  );
  console.log(
    `\nDone. ${tot.broken} broken · ${tot.review} needs-review · ${tot.ok} ok ` +
      `(counts are per-site unique URLs; a URL on two sites counts once each).`
  );
  console.log(`Wrote ${OUT_JS} and ${OUT_JSON}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
