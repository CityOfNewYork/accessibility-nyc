// scan-core.mjs — the scoring and measurement rules shared by every scanner.
//
// There are two scanners: scan.js (link crawler) and scan-finders.mjs
// (interaction-driven, for form-gated / SPA finder apps). They discover pages
// very differently, but once a page is loaded they must measure it IDENTICALLY
// — the dashboard merges their output into one results.json and one scorecard,
// so a site's tier has to mean the same thing whichever tool produced it.
//
// This module exists because "mirror scan.js — keep in sync" was a comment, and
// the two drifted anyway: scan-finders.mjs tiered a serious-but-not-critical
// site RED while scan.js called the same counts ORANGE, which is a different
// public grade for the same findings. Anything that decides what counts, what a
// tier means, or what reaches history belongs here and nowhere else.
//
// test/check-core-shared.js fails the build if either scanner declares its own
// copy of one of these, so the drift can't silently come back.

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- third-party embeds ----------------------------------------------------

// Embeds whose findings are reported but NOT counted — excluded from counts,
// tiers, totals, and history. A deliberate case-by-case allowlist, not a
// blanket "ignore cross-origin iframes" rule:
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
// those can gate content that exists nowhere else on the page. Add a vendor
// here only after deciding that case on its merits.
export const EXCLUDED_EMBEDS = [
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
export async function embedFrameMap(page, violations) {
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

// Run axe, then tag any excluded-embed nodes in one step. Both scanners call
// this rather than tagging by hand, so neither can forget to.
export async function tagEmbeds(page, violations) {
  return tagEmbedNodes(violations, await embedFrameMap(page, violations));
}

// Inventory the excluded embeds on the page, whether or not they produced a
// finding. The dashboard's banner is advice about the embed itself ("make sure
// essential information is also on the page in another form"), which holds
// regardless of what axe found — and tying it to findings would make it blink
// on and off week to week as YouTube ships player changes.
export async function pageEmbeds(page) {
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

// ---- target selectors ------------------------------------------------------

// axe regenerates its selectors on every run and its choice of disambiguating
// attributes is unstable — the same iframe came back as
// iframe[title=…][height=…][allowfullscreen=""] on one pass and
// iframe[title=…][height=…][width="640"] on the next. Stripping [...] leaves
// the stable structural parts (tags, classes, ids, :nth-child), which is what
// both viewport dedup and suppression matching compare on.
export const stripAttrSelectors = (t) =>
  Array.isArray(t) ? t.map(stripAttrSelectors) : String(t).replace(/\[[^\]]*\]/g, "");

export function normTargetKey(target) {
  return JSON.stringify(stripAttrSelectors(target));
}

// The element selector a finding is ultimately about: the last entry of axe's
// target array (earlier entries are the frame path).
export const leafSelector = (target) =>
  Array.isArray(target) ? String(target[target.length - 1] ?? "") : String(target ?? "");

// ---- what counts -----------------------------------------------------------

// The nodes of a violation that count toward the score. Every total the
// dashboard and history report is built from this, so excluded-embed findings
// and verified false positives stay visible without ever affecting a tier.
export const countedNodes = (v) => v.nodes.filter((n) => !n.embed && !n.suppressed);

export const countedTotal = (violations) =>
  violations.reduce((sum, v) => sum + countedNodes(v).length, 0);

export const embedTotal = (violations) =>
  violations.reduce((sum, v) => sum + v.nodes.filter((n) => n.embed).length, 0);

export const suppressedTotal = (violations) =>
  violations.reduce((sum, v) => sum + v.nodes.filter((n) => n.suppressed).length, 0);

// Rules the page actually fails. A rule whose every node sits in an excluded
// embed is not a rule this page fails — it still appears in the embeds section,
// but it must not inflate the rule count the scorecard reports.
export const countedRules = (violations) =>
  violations.filter((v) => countedNodes(v).length > 0);

// The public grade. Orange means "serious issues remain but every critical one
// is resolved" — a distinction the dashboard and README both promise, and the
// reason this must not be redefined per scanner.
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

export function addCounts(a, b) {
  return {
    critical: a.critical + b.critical,
    serious: a.serious + b.serious,
    moderate: a.moderate + b.moderate,
    minor: a.minor + b.minor,
  };
}

export const emptyCounts = () => ({ critical: 0, serious: 0, moderate: 0, minor: 0 });

// Per-rule occurrence counts for a history entry. Excluded-embed nodes are
// absent from every other total; letting them in here would put them back into
// the trend chart by the side door.
export function rulesForHistory(pages) {
  const byRule = {};
  for (const p of pages) {
    for (const v of p.violations || []) {
      const counted = countedNodes(v).length;
      if (!counted) continue;
      if (!byRule[v.id]) byRule[v.id] = { id: v.id, impact: v.impact, count: 0 };
      byRule[v.id].count += counted;
    }
  }
  return Object.values(byRule);
}

// ---- verified false positives (suppressions) --------------------------------
//
// suppressions.json records findings a human checked and determined are wrong —
// axe reporting a failure that does not exist for a real user. Categorically
// different from the embed allowlist above, which says "this vendor's markup is
// not the agency's problem". A suppression says "this specific finding is not
// true", so it is scoped tightly and it expires.
//
// Design constraints, in order of how much they matter:
//
//   Suppressed is not deleted. The finding stays in results.json and renders in
//   its own dashboard section with the reason attached. Anyone running axe
//   themselves will find it, and the dashboard should already explain why we do
//   not count it. Hiding it is how the tool loses its credibility.
//
//   Every entry expires. A false positive is a claim about one page at one
//   moment; pages change and axe changes. Past `expires`, the entry stops
//   applying and the finding counts again, with a warning on the scan. Without
//   this the file becomes a place inconvenient findings go to die.
//
//   Matching is narrow. Rule + page + element selector, never rule + site. A
//   site-wide suppression would silently hide genuinely new failures. Selector
//   "*" widens it to every node of that rule on that page, but only as an
//   explicit, visible choice.
//
//   `reason` is mandatory. The risk this feature carries is that it becomes a
//   quiet way to make numbers look better. A written justification is the thing
//   that keeps it honest and the thing an auditor would ask for.

const SUPPRESSION_REQUIRED = ["site", "rule", "selector", "reason", "verified_on", "expires"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Turn a page pattern into a regex. Only `*` is special (matches any run of
// characters), so authors write URLs, not regexes.
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Validate and compile suppressions.json. Throws on a malformed entry rather
// than skipping it: a suppression that silently fails to load is worse than a
// broken scan, because the numbers still look plausible.
export function compileSuppressions(raw, { today = new Date() } = {}) {
  if (!Array.isArray(raw)) throw new Error("suppressions.json must be a JSON array");
  const active = [];
  const expired = [];
  for (const [i, entry] of raw.entries()) {
    const where = `suppressions.json[${i}]`;
    for (const field of SUPPRESSION_REQUIRED) {
      if (!entry[field] || String(entry[field]).trim() === "") {
        throw new Error(`${where}: missing required field "${field}"`);
      }
    }
    if (!entry.page && !entry.pagePattern) {
      throw new Error(`${where}: needs either "page" (exact URL) or "pagePattern"`);
    }
    if (entry.page && entry.pagePattern) {
      throw new Error(`${where}: set "page" or "pagePattern", not both`);
    }
    for (const field of ["verified_on", "expires"]) {
      if (!ISO_DATE.test(entry[field])) {
        throw new Error(`${where}: "${field}" must be YYYY-MM-DD, got "${entry[field]}"`);
      }
    }
    if (entry.expires <= entry.verified_on) {
      throw new Error(`${where}: "expires" must be after "verified_on"`);
    }
    const compiled = {
      ...entry,
      matchPage: entry.page
        ? (url) => url === entry.page
        : ((re) => (url) => re.test(url))(patternToRegex(entry.pagePattern)),
      selectorKey: stripAttrSelectors(entry.selector),
    };
    // Date-only comparison in ISO form sorts lexicographically, so no parsing.
    const todayIso = today.toISOString().slice(0, 10);
    (entry.expires < todayIso ? expired : active).push(compiled);
  }
  return { active, expired };
}

// Does this suppression cover this node? Selectors are compared with attribute
// selectors stripped, because axe regenerates them per run and an exact-string
// match would quietly stop working the week axe picked a different attribute.
function suppressionMatches(sup, ruleId, pageUrl, node) {
  if (sup.rule !== ruleId) return false;
  if (!sup.matchPage(pageUrl)) return false;
  if (sup.selector === "*") return true;
  return leafSelector(stripAttrSelectors(node.target)) === sup.selectorKey;
}

// Tag nodes covered by an active suppression. Like embed tags, these stay in
// the output and are skipped by every counting path.
export function tagSuppressions(violations, pageUrl, suppressions) {
  if (!suppressions || !suppressions.active.length) return violations;
  for (const v of violations) {
    for (const n of v.nodes) {
      // A node already excluded as vendor markup needs no second reason, and
      // tagging it twice would double-count it across the two totals. Embed
      // wins, matching how the dashboard buckets them.
      if (n.embed) continue;
      const hit = suppressions.active.find((sup) => suppressionMatches(sup, v.id, pageUrl, n));
      if (hit) {
        n.suppressed = {
          reason: hit.reason,
          verified_on: hit.verified_on,
          expires: hit.expires,
        };
      }
    }
  }
  return violations;
}

// Expired entries that still match something are reported so they get renewed
// or deleted deliberately, instead of rotting unnoticed.
export function expiredSuppressionsInUse(violations, pageUrl, suppressions) {
  if (!suppressions || !suppressions.expired.length) return [];
  const hits = [];
  for (const sup of suppressions.expired) {
    for (const v of violations) {
      if (v.nodes.some((n) => suppressionMatches(sup, v.id, pageUrl, n))) {
        hits.push(sup);
        break;
      }
    }
  }
  return hits;
}

// ---- slimming --------------------------------------------------------------

export function slimViolations(violations) {
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
// locate. Kept OUT of counts, tier, total_violations, distinct_rules, history.
export function slimIncomplete(incomplete) {
  return incomplete.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target),
  }));
}

// ---- page settling ---------------------------------------------------------

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
export const SETTLE_MAX_STEPS = 12;
export const SETTLE_STEP_MS = 250;
export const SETTLE_MAX_MS = 5_000;

export async function settlePage(page, enabled = true) {
  if (!enabled) return;
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

// ---- result assembly -------------------------------------------------------

// Merge a run's fresh site records with the previous results.json, emitted in
// sites.json order. A site not scanned this run keeps its last record, which is
// what lets a single-site run leave every other site intact — and what keeps a
// retired site's last scan on file after it stops being measured.
//
// `retired` is stamped here from sites.json rather than stored by the scanners,
// so retiring or restoring a site takes effect without a rescan.
export function mergeSitesWithPrior(all, fresh, prior) {
  const freshByName = new Map(fresh.map((r) => [r.name, r]));
  const priorByName = new Map(prior.map((r) => [r.name, r]));
  return all
    .map((s) => {
      const rec = freshByName.get(s.name) ?? priorByName.get(s.name);
      if (!rec) return null;
      return s.retired ? { ...rec, retired: true } : rec;
    })
    .filter(Boolean);
}
