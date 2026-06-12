// discover.mjs — Link-graph discovery for ONE site. No accessibility scanning.
//
// Walks same-origin, in-scope pages breadth-first so we can SIZE the real crawl
// before committing axe-scan time. The link filter here is byte-for-byte the
// same as scan.js's sameOriginLinks (same-origin, no query strings, pathPrefix,
// self-dedupe) so the counts it reports predict exactly what a full scan.js
// crawl would visit.
//
// It is deliberately polite: one page at a time, sequential, no parallelism.
//
// Usage:
//   node discover.mjs                       # nyc.gov /main, cap 500 pages
//   node discover.mjs --max-pages=40        # quick smoke / early shape
//   node discover.mjs --max-depth=3         # stop following links past 3 hops
//   node discover.mjs --url=https://www.nyc.gov --prefix=/main
//
// Throwaway-ish: its BFS + filter logic is the prototype for the eventual
// scan.js crawl refactor. Delete once that lands.

import puppeteer from "puppeteer";

function parseArgs(argv) {
  const o = { url: "https://www.nyc.gov", prefix: "/main", maxPages: 500, maxDepth: Infinity };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--url=")) o.url = a.slice("--url=".length);
    else if (a.startsWith("--prefix=")) o.prefix = a.slice("--prefix=".length);
    else if (a.startsWith("--max-pages=")) o.maxPages = Number(a.slice("--max-pages=".length));
    else if (a.startsWith("--max-depth=")) o.maxDepth = Number(a.slice("--max-depth=".length));
  }
  return o;
}

// Identical filter to scan.js sameOriginLinks — keep these in sync.
function extractLinks(page, base, prefix) {
  return page.evaluate((base, prefix) => {
    const BINARY = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|mp[34]|geojson|json|csv|xml|kmz?)$/i;
    const origin = new URL(base).origin;
    const self = new URL(base);
    self.search = "";
    self.hash = "";
    const selfHref = self.href;
    const seen = new Set();
    const out = [];
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
          out.push(href);
        }
      } catch {}
    }
    return out;
  }, base, prefix);
}

// Query/hash-stripped href — the identity we de-dupe the crawl on.
const norm = (h) => {
  const u = new URL(h);
  u.search = "";
  u.hash = "";
  return u.href;
};

async function main() {
  const opt = parseArgs(process.argv);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const r0 = await page.goto(opt.url, { waitUntil: "networkidle2", timeout: 60_000 });
  const entry = page.url();
  console.log(`Entry:  ${opt.url} -> ${entry} (HTTP ${r0?.status() ?? "?"})`);
  console.log(`Scope:  prefix=${opt.prefix}  maxPages=${opt.maxPages}  maxDepth=${opt.maxDepth}\n`);

  const seen = new Set();        // every norm href ever enqueued (true size so far)
  const depthOf = new Map();     // norm href -> hops from entry
  const errors = [];
  const queue = [];

  const entryKey = norm(entry);
  seen.add(entryKey);
  depthOf.set(entryKey, 0);
  queue.push(entry);

  let fetched = 0;
  const t0 = Date.now();

  while (queue.length && fetched < opt.maxPages) {
    const url = queue.shift();
    const key = norm(url);
    const depth = depthOf.get(key) ?? 0;
    fetched++;

    let links = [];
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
      const status = resp?.status() ?? 0;
      if (status >= 400) throw new Error(`HTTP ${status}`);
      if (depth < opt.maxDepth) links = await extractLinks(page, page.url(), opt.prefix);
    } catch (e) {
      errors.push({ url: key, error: e.message });
      process.stdout.write(`  [${String(fetched).padStart(4)}] d${depth} ERROR ${e.message}\n`);
      continue;
    }

    let added = 0;
    for (const l of links) {
      const lk = norm(l);
      if (!seen.has(lk)) {
        seen.add(lk);
        depthOf.set(lk, depth + 1);
        queue.push(l);
        added++;
      }
    }
    if (fetched <= 5 || fetched % 10 === 0) {
      process.stdout.write(
        `  [${String(fetched).padStart(4)}] d${depth} +${added} link(s) (frontier ${queue.length}, total ${seen.size})\n`
      );
    }
  }

  await browser.close();

  const hitCap = fetched >= opt.maxPages && queue.length > 0;
  const byDepth = {};
  for (const k of seen) {
    const d = depthOf.get(k) ?? 0;
    byDepth[d] = (byDepth[d] || 0) + 1;
  }
  const bySeg = {};
  for (const k of seen) {
    const seg = "/" + (new URL(k).pathname.split("/")[1] || "");
    bySeg[seg] = (bySeg[seg] || 0) + 1;
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const estMin = Math.round((seen.size * 3) / 60);

  console.log(`\n================ DISCOVERY REPORT ================`);
  console.log(`Entry:               ${entry}`);
  console.log(`Scope prefix:        ${opt.prefix}`);
  console.log(`Pages fetched:       ${fetched}  (this dry run, ${mins} min)`);
  console.log(`Unique in-scope:     ${seen.size}  ${hitCap ? "← LOWER BOUND, hit --max-pages cap" : "(frontier exhausted — full tree)"}`);
  console.log(`Frontier remaining:  ${queue.length}`);
  console.log(`Errors:              ${errors.length}`);
  console.log(`\nDiscovered pages by depth (hops from entry):`);
  for (const d of Object.keys(byDepth).map(Number).sort((a, b) => a - b)) {
    console.log(`  depth ${d}: ${byDepth[d]}`);
  }
  console.log(`\nDiscovered pages by first path segment:`);
  for (const [s, n] of Object.entries(bySeg).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${s}`);
  }
  if (errors.length) {
    console.log(`\nFirst 10 errors:`);
    errors.slice(0, 10).forEach((e) => console.log(`  ${e.error}  ${e.url}`));
  }
  console.log(
    `\nEst. full axe crawl (~3s/page, sequential): ~${estMin} min for ${seen.size} pages` +
      (hitCap ? " (true total is higher)" : "")
  );
  console.log(`==================================================`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
