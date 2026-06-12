// app.js — render SCAN_DATA into either an overview or per-site detail view.
//
// View routing: `?site=<name>` shows detail; otherwise overview.
// No router, no framework. Plain DOM building.

(function () {
  "use strict";

  const data = window.SCAN_DATA;
  const app = document.getElementById("app");
  const footerMeta = document.getElementById("footer-meta");

  // A single visually-hidden polite live region. Status changes that are only
  // conveyed visually elsewhere — "Copied", search match counts — are mirrored
  // here so assistive tech announces them. One shared node; we clear then set
  // so identical consecutive messages still re-announce.
  const liveRegion = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  document.body.appendChild(liveRegion);
  let announceTimer = null;
  function announce(msg) {
    liveRegion.textContent = "";
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { liveRegion.textContent = msg; }, 60);
  }

  if (!data || !Array.isArray(data.sites)) {
    app.innerHTML = `<div class="error-banner">
      <p class="error-banner-label">No scan data</p>
      <p class="error-banner-body">Run <code>node scan.js</code> from the project root, then reload.</p>
    </div>`;
    return;
  }

  // ---- helpers --------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  const fmtNum = (n) => n.toLocaleString("en-US");

  function fmtDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return rem ? `${m} min ${rem} s` : `${m} min`;
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch { return iso; }
  }

  function fmtDateShort(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch { return iso; }
  }

  const tierLabel = {
    red:    "Critical issues",
    orange: "Serious issues",
    yellow: "Some issues",
    green:  "Clean",
    error:  "Scan error",
  };
  const tierClass = {
    red:    "tier-red",
    orange: "tier-orange",
    yellow: "tier-amber",
    green:  "tier-green",
    error:  "tier-error",
  };

  function tierPill(tier) {
    return el("span", { class: `tier-pill ${tierClass[tier] || "tier-error"}` }, tierLabel[tier] || tier);
  }

  function impactRow(counts) {
    const order = ["critical", "serious", "moderate", "minor"];
    const chips = order
      .filter((k) => counts[k] > 0)
      .map((k) =>
        el("span", { class: `impact-chip imp-${k}` },
          fmtNum(counts[k]),
          el("span", { class: "lbl" }, k)
        )
      );
    if (chips.length === 0) {
      chips.push(el("span", { class: "impact-chip imp-none" }, el("span", { class: "lbl" }, "None")));
    }
    return el("div", { class: "impact-bars" }, chips);
  }

  function methodologyCallout(detailed) {
    return el("section", { class: "methodology" },
      el("div", { class: "methodology-label" }, detailed ? "Methodology" : "Floor check"),
      detailed
        ? el("p", { class: "methodology-body" },
            "This is a ", el("strong", {}, "floor check, not a certification"),
            ". Automated tools detect roughly 30–57% of WCAG failures. Meaningful alt text, focus order, screen-reader operability, and cognitive clarity require manual review and assistive-technology testing. Sites are evaluated against ",
            el("strong", {}, "WCAG 2.2 AA"),
            ", required of City agencies by Local Law 26 of 2016 and adopted as the current version by OTI and MOPD in the 2025 Digital Accessibility Report.")
        : el("p", { class: "methodology-body" },
            "Automated scan against ",
            el("strong", {}, "WCAG 2.2 AA"),
            ". Catches roughly 30–57% of failures; the remainder requires manual review and assistive-technology testing.")
    );
  }

  function sectionEyebrow(title, sub) {
    return el("div", { class: "section-eyebrow" },
      el("h2", { class: "section-eyebrow-title" }, title),
      sub ? el("p", { class: "section-eyebrow-sub" }, sub) : null
    );
  }

  function summaryCell(label, value, sub, valueClass) {
    return el("div", { class: "summary-cell" },
      el("div", { class: "summary-cell-label" }, label),
      el("div", { class: "summary-cell-value" + (valueClass ? " " + valueClass : "") }, value),
      sub ? el("div", { class: "summary-cell-sub" }, sub) : null
    );
  }

  function statBlock(value, label) {
    return el("div", {},
      el("div", { class: "detail-header-stat-num" }, String(value)),
      el("div", { class: "detail-header-stat-lbl" }, label)
    );
  }

  // ---- search index + page lookup ------------------------------------------

  function pageLabel(url, isHome) {
    if (isHome) return "Homepage";
    try {
      const p = new URL(url).pathname.replace(/\/$/, "");
      return p || "/";
    } catch { return url; }
  }

  // Derive a tier from impact counts. Same thresholds as scan.js (mirrored).
  // Sites are re-derived here too (not read from the stored site.tier) so the
  // tier ladder can change without waiting for the next scan to rewrite data.
  function tierFromCounts(counts) {
    if (!counts) return "green";
    if (counts.critical > 0) return "red";
    if (counts.serious > 0) return "orange";
    if (counts.moderate > 0 || counts.minor > 0) return "yellow";
    return "green";
  }

  function siteTier(s) {
    return s.tier === "error" ? "error" : tierFromCounts(s.counts);
  }

  function siteViolations(site) {
    if (site.violations) return site.violations;
    if (!site.pages) return [];
    return site.pages.flatMap((p) => p.violations || []);
  }

  // Flatten scan data into searchable lists. Built once on load — the dataset
  // is small (≈1k pages) so a linear filter on each keystroke is fine.
  function buildSearchIndex(data) {
    const pages = [];
    const rules = new Map();
    const sites = data.sites.map((s) => ({
      name: s.name,
      url: s.url,
      tier: siteTier(s),
      pageCount: s.pages ? s.pages.length : 1,
      totalViolations: s.total_violations,
    }));

    for (const site of data.sites) {
      const sitePages = site.pages || [site];
      sitePages.forEach((p, i) => {
        const label = p.label || pageLabel(p.url, !site.pages || i === 0);
        const occ = (p.violations || []).reduce((sum, v) => sum + v.nodes.length, 0);
        pages.push({
          siteName: site.name,
          url: p.url,
          label,
          tier: tierFromCounts(p.counts),
          occurrences: occ,
          ruleCount: (p.violations || []).length,
        });
        for (const v of p.violations || []) {
          let r = rules.get(v.id);
          if (!r) {
            r = { id: v.id, impact: v.impact, help: v.help, sites: new Set(), occurrences: 0, pages: 0 };
            rules.set(v.id, r);
          }
          r.sites.add(site.name);
          r.occurrences += v.nodes.length;
          r.pages++;
        }
      });
    }

    return {
      pages,
      sites,
      rules: [...rules.values()].map((r) => ({ ...r, sites: [...r.sites] })),
    };
  }

  // Case-insensitive substring search across pages, sites, rules.
  function searchAll(index, query) {
    const q = query.trim().toLowerCase();
    if (!q) return { pages: [], sites: [], rules: [], empty: true };
    const inStr = (s) => String(s || "").toLowerCase().includes(q);
    return {
      pages: index.pages.filter((p) => inStr(p.url) || inStr(p.label) || inStr(p.siteName)),
      sites: index.sites.filter((s) => inStr(s.name)),
      rules: index.rules.filter((r) => inStr(r.id) || inStr(r.help)),
      empty: false,
    };
  }

  // Locate a page in the dataset by its full URL. Returns { site, page } or
  // null. Single-page sites have violations at the site level; we treat the
  // site itself as the "page" in that case.
  function findPageByUrl(data, url) {
    for (const site of data.sites) {
      if (site.pages) {
        const page = site.pages.find((p) => p.url === url);
        if (page) return { site, page };
      } else if (site.url === url) {
        return { site, page: site };
      }
    }
    return null;
  }

  // ---- overview -------------------------------------------------------------

  function totalPages(sites) {
    return sites.reduce((sum, s) => sum + (s.pages ? s.pages.length : 1), 0);
  }

  function renderOverview() {
    const sites = data.sites;
    const tiers = { red: 0, orange: 0, yellow: 0, green: 0, error: 0 };
    let totalIssues = 0, totalRules = 0;
    for (const s of sites) {
      tiers[siteTier(s)]++;
      totalIssues += s.total_violations;
      totalRules += s.distinct_rules;
    }

    const pageCount = totalPages(sites);
    const summary = el("section", { class: "summary-strip" },
      summaryCell("Sites scanned", String(sites.length), pageCount > sites.length ? `${pageCount} pages total` : null),
      summaryCell("Rules failed", String(totalRules), `${fmtNum(totalIssues)} total occurrences`),
      summaryCell("Critical issues", String(tiers.red), null, "is-red"),
      summaryCell("Serious issues", String(tiers.orange), null, "is-orange"),
      summaryCell("Some issues", String(tiers.yellow), null, "is-amber"),
      summaryCell("Clean", String(tiers.green), tiers.error ? `${tiers.error} scan error${tiers.error === 1 ? "" : "s"}` : null, "is-green"),
    );

    const headerRow = el("tr", {},
      el("th", {}, "Agency site"),
      el("th", {}, "Tier"),
      el("th", { class: "numeric" }, "Pages"),
      el("th", { class: "numeric" }, "Rules Failed"),
      el("th", {}, "Occurrences"),
      el("th", { class: "top-rule-col" }, "Top rule"),
      el("th", { class: "top-rule-col" }, "Last scan")
    );

    const rows = sites.map((s) => {
      const link = `?site=${encodeURIComponent(s.name)}`;
      const allViolations = siteViolations(s);
      const topViolation = allViolations.length > 0 ? allViolations.reduce((a, b) => b.nodes.length > a.nodes.length ? b : a) : null;
      const numPages = s.pages ? s.pages.length : 1;
      const tr = el("tr", {
        onclick: (e) => {
          if (e.target.closest("a")) return;
          location.href = link;
        }
      },
        el("td", {},
          el("a", { class: "site-name", href: link }, s.name),
          el("div", { class: "site-url" }, s.url)
        ),
        el("td", {}, tierPill(siteTier(s))),
        el("td", { class: "numeric" }, String(numPages)),
        el("td", { class: "numeric" }, s.error ? "—" : String(s.distinct_rules)),
        el("td", {},
          s.error
            ? el("span", { class: "impact-chip imp-none" }, el("span", { class: "lbl" }, "Error"))
            : impactRow(s.counts)
        ),
        el("td", { class: "top-rule-cell top-rule-col" },
          topViolation
            ? [topViolation.id, el("span", { class: "count" }, `(${topViolation.nodes.length}×)`)]
            : "—"
        ),
        el("td", {
          class: "top-rule-cell top-rule-col",
          title: fmtDate(s.scanned_at || data.scanned_at),
        }, fmtDateShort(s.scanned_at || data.scanned_at))
      );
      return tr;
    });

    const sitesTable = el("div", { class: "sites-table-wrap" },
      el("table", { class: "sites-table" },
        el("thead", {}, headerRow),
        el("tbody", {}, rows)
      )
    );

    const eyebrowSub = pageCount > sites.length
      ? `${sites.length} sites · ${pageCount} pages scanned · click a row for details`
      : `${sites.length} scanned · click a row for details`;

    // Search bar + swappable body. The body holds either the agency table
    // (when the query is empty) or the search results panel (when not).
    // Building the table once and keeping the input element alive across
    // updates preserves focus mid-typing.
    let query = "";
    let index = null;
    const tableBlock = el("div", {},
      sectionEyebrow("Agency sites", eyebrowSub),
      sitesTable
    );
    const body = el("div", { class: "overview-body" }, tableBlock);

    function update() {
      if (!query.trim()) {
        body.replaceChildren(tableBlock);
        announce("");
        return;
      }
      if (!index) index = buildSearchIndex(data);
      const matches = searchAll(index, query);
      const total = matches.pages.length + matches.sites.length + matches.rules.length;
      announce(total === 0
        ? `No matches for ${query}`
        : `${fmtNum(total)} result${total === 1 ? "" : "s"} for ${query}`);
      body.replaceChildren(renderSearchResults(matches, query));
    }

    const searchInput = el("input", {
      type: "search",
      class: "search-input",
      placeholder: 'Paste a URL or search a path or rule  (e.g. "mopd/resources")',
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Search pages, sites, or rules",
      oninput: (e) => { query = e.target.value; update(); },
    });

    const searchBar = el("div", { class: "search-bar" },
      el("span", { class: "search-bar-icon", "aria-hidden": "true" }, "⌕"),
      searchInput
    );

    app.replaceChildren(
      methodologyCallout(true),
      summary,
      searchBar,
      body
    );
  }

  // Render the search results panel. Three sections (sites / pages / rules);
  // each capped so the panel stays scannable. Sites lead so a site-name query
  // isn't buried under its own pages; page rows are the primary hit for a
  // URL/path query and click through to the per-page detail view.
  function renderSearchResults(matches, query) {
    const PAGE_LIMIT = 25;
    const RULE_LIMIT = 10;
    const SITE_LIMIT = 10;

    const totalHits = matches.pages.length + matches.sites.length + matches.rules.length;
    if (totalHits === 0) {
      return el("div", { class: "search-empty" },
        el("p", { class: "search-empty-title" }, "No scanned page matches"),
        el("p", { class: "search-empty-body" },
          `Nothing matched "${query}" across pages, sites, or rules. ` +
          `The URL may not have been included in the last crawl (current cap: 1000 pages per site). Try a shorter path or a different keyword.`
        )
      );
    }

    const sections = [];

    // Sites first: a site-name query (e.g. "OTI") matches every one of that
    // site's pages by siteName, which would otherwise bury the single site
    // result under a flood of page rows. A URL/path query matches no site
    // name, so pages still lead in that case.
    if (matches.sites.length) {
      const shown = matches.sites.slice(0, SITE_LIMIT);
      sections.push(el("section", { class: "search-section" },
        el("h3", { class: "search-section-title" },
          "Sites",
          el("span", { class: "search-section-count" },
            ` — ${matches.sites.length} match${matches.sites.length === 1 ? "" : "es"}`)
        ),
        el("ul", { class: "search-result-list" },
          shown.map((s) => {
            const href = `?site=${encodeURIComponent(s.name)}`;
            return el("li", {},
              el("a", { class: "search-result", href },
                el("span", { class: `search-result-tier tier-pill ${tierClass[s.tier] || "tier-error"}` }, tierLabel[s.tier] || s.tier),
                el("div", { class: "search-result-body" },
                  el("div", { class: "search-result-label" }, s.name),
                  el("div", { class: "search-result-url" }, s.url)
                ),
                el("div", { class: "search-result-meta" },
                  `${s.pageCount} page${s.pageCount === 1 ? "" : "s"} · ${fmtNum(s.totalViolations)} occurrence${s.totalViolations === 1 ? "" : "s"}`
                ),
                el("span", { class: "search-result-arrow", "aria-hidden": "true" }, "›")
              )
            );
          })
        )
      ));
    }

    if (matches.pages.length) {
      const shown = matches.pages.slice(0, PAGE_LIMIT);
      sections.push(el("section", { class: "search-section" },
        el("h3", { class: "search-section-title" },
          "Pages",
          el("span", { class: "search-section-count" },
            ` — ${fmtNum(matches.pages.length)} match${matches.pages.length === 1 ? "" : "es"}`)
        ),
        el("ul", { class: "search-result-list" },
          shown.map((p) => {
            const href = `?page=${encodeURIComponent(p.url)}`;
            return el("li", {},
              el("a", { class: "search-result", href },
                el("span", { class: `search-result-tier tier-pill ${tierClass[p.tier] || "tier-error"}` }, tierLabel[p.tier] || p.tier),
                el("div", { class: "search-result-body" },
                  el("div", { class: "search-result-label" }, p.siteName, el("span", { class: "search-result-sep" }, " · "), p.label),
                  el("div", { class: "search-result-url" }, p.url)
                ),
                el("div", { class: "search-result-meta" },
                  p.occurrences === 0
                    ? el("span", { class: "search-result-clean" }, "clean")
                    : `${fmtNum(p.occurrences)} occurrence${p.occurrences === 1 ? "" : "s"}`
                ),
                el("span", { class: "search-result-arrow", "aria-hidden": "true" }, "›")
              )
            );
          }),
          matches.pages.length > PAGE_LIMIT
            ? el("li", { class: "search-result-more" },
                `+ ${fmtNum(matches.pages.length - PAGE_LIMIT)} more page matches not shown — refine your query`)
            : null
        )
      ));
    }

    if (matches.rules.length) {
      const shown = matches.rules.slice(0, RULE_LIMIT);
      sections.push(el("section", { class: "search-section" },
        el("h3", { class: "search-section-title" },
          "Rules",
          el("span", { class: "search-section-count" },
            ` — ${matches.rules.length} match${matches.rules.length === 1 ? "" : "es"}`)
        ),
        el("ul", { class: "search-result-list" },
          shown.map((r) =>
            el("li", { class: "search-result-rule" },
              el("span", { class: `v-impact imp-${r.impact}` }, r.impact),
              el("div", { class: "search-result-body" },
                el("div", { class: "search-result-label" }, r.id),
                el("div", { class: "search-result-url" }, r.help)
              ),
              el("div", { class: "search-result-meta" },
                `${fmtNum(r.occurrences)} occurrence${r.occurrences === 1 ? "" : "s"} · `,
                r.sites.length === 1
                  ? el("a", { href: `?site=${encodeURIComponent(r.sites[0])}` }, r.sites[0])
                  : `${r.sites.length} sites`
              )
            )
          )
        )
      ));
    }

    return el("div", { class: "search-results" }, sections);
  }

  // ---- per-site detail ------------------------------------------------------

  // The short subtitle shown under the axe help text, both collapsed and
  // expanded. Deliberately uses `title` (a one-line gloss) rather than `plain`
  // — `plain` is the fuller "What this means" line in the expanded card, and
  // printing it here too would duplicate it verbatim within one finding.
  function ruleExplain(v) {
    const info = (window.RULE_INFO || {})[v.id];
    return (info && info.title) ? el("p", { class: "v-explain" }, info.title) : null;
  }

  // A devtools one-liner that scrolls to the failing element and flashes it
  // with a red outline. Text-fragment URLs are unreliable on enterprise/SPA
  // sites (entity differences, async content, force-load-at-top); a snippet
  // the engineer pastes into the live page's console always works.
  function buildLocateScript(selector) {
    const s = JSON.stringify(selector);
    return `(()=>{const e=document.querySelector(${s});if(!e){alert('Element not found on this page: '+${s});return}e.scrollIntoView({block:'center',behavior:'smooth'});const o=e.style.outline,f=e.style.outlineOffset;e.style.outline='3px solid #ff3b30';e.style.outlineOffset='3px';setTimeout(()=>{e.style.outline=o;e.style.outlineOffset=f},3000)})()`;
  }

  // A finding (one rule on the current site/page route) is addressable by a URL
  // fragment so it can be pasted into a ticket. Rule ids are already kebab-case
  // and hash-safe; they appear at most once per route, so the id is unique.
  function findingDomId(ruleId) {
    return `rule-${ruleId}`;
  }

  function permalinkButton(domId) {
    return el("button", {
      type: "button",
      class: "v-permalink",
      title: "Copy a direct link to this finding — paste into a ticket",
      onclick: (e) => {
        const url = `${location.origin}${location.pathname}${location.search}#${domId}`;
        copyToClipboard(url, e.currentTarget);
      },
    }, "Copy link");
  }

  // On load (and on hashchange), open and scroll to the finding named in the URL
  // fragment, briefly highlighting it so a ticket link lands the reader on the
  // exact row.
  function applyHashTarget() {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    if (target.tagName === "DETAILS") target.open = true;
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
      target.classList.add("is-link-target");
      setTimeout(() => target.classList.remove("is-link-target"), 2000);
    });
  }

  function copyToClipboard(text, btn) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.dataset.origLabel || btn.textContent;
      btn.dataset.origLabel = orig;
      btn.textContent = "Copied";
      btn.classList.add("is-copied");
      announce(`${orig} — copied to clipboard`);
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove("is-copied");
      }, 1200);
    }).catch(() => {});
  }

  // axe's failureSummary is either generic boilerplate ("Fix any of the
  // following:" + static conditions, identical on every occurrence — see
  // sharedFailureSummary) or element-specific measurements (contrast ratios,
  // pixel sizes). We drop the generic case entirely (the plain-language
  // explanation + the "How to fix" link cover it) and, for the specific case,
  // strip axe's wrapper line and keep just the measured detail.
  function distillFailure(summary) {
    return String(summary)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^Fix (any|all) of the following:?$/i.test(l))
      .join(" · ");
  }

  // One occurrence of a rule failure: selector + HTML snippet + deep link to the
  // live page, plus the element-specific failure detail when showFailure is set
  // (generic, shared summaries are suppressed here and handled at the finding
  // level). Shared between the single-page and multi-page rendering paths.
  function renderNode(n, pageUrl, showFailure = true) {
    const selector = Array.isArray(n.target) ? n.target.join(" ") : String(n.target);

    return el("li", { class: "v-node" },
      el("div", { class: "v-node-row" },
        el("code", { class: "v-node-selector" }, selector),
        el("div", { class: "v-node-actions" },
          el("button", {
            type: "button",
            class: "v-node-btn",
            title: "Copy CSS selector to clipboard",
            onclick: (e) => copyToClipboard(selector, e.currentTarget),
          }, "Copy selector"),
          el("button", {
            type: "button",
            class: "v-node-btn",
            title: "Copy a devtools one-liner. Open the page, then paste in the console to scroll to and highlight this element.",
            onclick: (e) => copyToClipboard(buildLocateScript(selector), e.currentTarget),
          }, "Copy locate script"),
          pageUrl
            ? el("a", {
                class: "v-node-btn",
                href: pageUrl,
                target: "_blank",
                rel: "noopener",
                title: "Open page in a new tab",
              }, "Open page ↗")
            : null
        )
      ),
      el("pre", { class: "v-node-html" }, el("code", {}, n.html || "")),
      showFailure && n.failureSummary
        ? el("p", { class: "v-node-failure" }, distillFailure(n.failureSummary))
        : null
    );
  }

  // The failure summary is generic (rule-level boilerplate) when it's identical
  // across every occurrence; in that case we suppress it. When it differs, it's
  // carrying per-element measurements worth showing on each occurrence.
  function sharedFailureSummary(nodes) {
    const summaries = nodes.map((n) => n.failureSummary).filter(Boolean);
    if (summaries.length === 0) return null;
    return summaries.every((s) => s === summaries[0]) ? summaries[0] : null;
  }

  function explanationBlock(ruleId) {
    const info = (window.RULE_INFO || {})[ruleId];
    if (!info) return null;
    return el("div", { class: "v-plain" },
      el("p", { class: "v-plain-line" },
        el("span", { class: "v-plain-tag" }, "What this means"),
        el("span", { class: "v-plain-text" }, info.plain)
      ),
      el("p", { class: "v-plain-line" },
        el("span", { class: "v-plain-tag" }, "Who it affects"),
        el("span", { class: "v-plain-text" }, info.impact)
      )
    );
  }

  // Collapse violations across all pages by rule id. The same rule firing on
  // 10 pages is one finding ("appears on 10 of 11 pages"), not 10 problems —
  // this is what makes the count read honestly.
  function groupByRule(pages) {
    const byRule = new Map();
    pages.forEach((p, i) => {
      // App-driven scans (scan-finders.mjs) supply a human label per
      // interaction state; crawled pages fall back to the URL-derived label.
      const label = p.label || pageLabel(p.url, i === 0);
      for (const v of p.violations || []) {
        let g = byRule.get(v.id);
        if (!g) {
          g = { v, pages: [], total: 0 };
          byRule.set(v.id, g);
        }
        g.pages.push({ url: p.url, label, count: v.nodes.length, nodes: v.nodes });
        g.total += v.nodes.length;
      }
    });

    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    return [...byRule.values()].sort((a, b) => {
      const oa = order[a.v.impact] ?? 99, ob = order[b.v.impact] ?? 99;
      if (oa !== ob) return oa - ob;
      return b.total - a.total;
    });
  }

  function renderGroupedByRule(pages, totalPages) {
    return el("div", { class: "violations-list" },
      groupByRule(pages).map((g) => renderRuleGroup(g, totalPages))
    );
  }

  function renderRuleGroup(g, totalPages) {
    const v = g.v;
    const wcagTag = v.tags.find((t) => /^wcag\d{2,3}$/.test(t));
    const wcagLabel = wcagTag
      ? "WCAG " + wcagTag.replace("wcag", "").split("").join(".")
      : null;
    const nPages = g.pages.length;

    // Suppress the per-occurrence failure summary when it's generic boilerplate
    // (identical across every occurrence); show it only when it varies, i.e.
    // carries element-specific measurements.
    const showFailure = !sharedFailureSummary(g.pages.flatMap((p) => p.nodes || []));

    const NODE_LIMIT_PER_PAGE = 5;
    const pageItems = g.pages.map((p) => {
      const shown = (p.nodes || []).slice(0, NODE_LIMIT_PER_PAGE);
      const remaining = (p.nodes || []).length - shown.length;
      // Collapsed by default: you scan the page headers (label · count · open)
      // and expand a page to see its occurrences. The label already shows the
      // path, so the meta links out with a compact "Open ↗" rather than
      // repeating the full URL; stopPropagation keeps the link from toggling.
      return el("details", { class: "v-page-group" },
        el("summary", { class: "v-page-header" },
          el("div", { class: "v-page-label", title: p.label }, p.label),
          el("div", { class: "v-page-meta" },
            `${fmtNum(p.count)} occurrence${p.count === 1 ? "" : "s"} · `,
            el("a", { href: p.url, target: "_blank", rel: "noopener",
              title: p.url, onclick: (e) => e.stopPropagation() }, "Open ↗")
          )
        ),
        el("ul", { class: "v-nodes" },
          shown.map((n) => renderNode(n, p.url, showFailure)),
          remaining > 0
            ? el("li", { class: "v-nodes-more" },
                `+ ${fmtNum(remaining)} more occurrence${remaining === 1 ? "" : "s"} on this page`)
            : null
        )
      );
    });

    return el("details", { class: "violation", id: findingDomId(v.id) },
      el("summary", {},
        el("span", { class: `v-impact imp-${v.impact}` }, v.impact),
        el("div", { class: "v-headline" },
          el("p", { class: "v-help" }, v.help),
          ruleExplain(v),
          el("div", { class: "v-meta" },
            el("span", { class: "v-rule-id" }, v.id),
            wcagLabel ? el("span", { class: "v-wcag" }, wcagLabel) : null,
            el("span", { class: "v-pages-badge" },
              `on ${nPages} of ${totalPages} page${totalPages === 1 ? "" : "s"}`)
          )
        ),
        el("div", { class: "v-count" },
          el("strong", {}, fmtNum(g.total)), " ",
          g.total === 1 ? "occurrence" : "occurrences"
        )
      ),
      el("div", { class: "v-body" },
        explanationBlock(v.id),
        el("div", { class: "v-actions-row" },
          el("a", { class: "v-fix", href: v.helpUrl, target: "_blank", rel: "noopener" },
            "How to fix",
            el("span", { class: "v-fix-arrow" }, "→")
          ),
          permalinkButton(findingDomId(v.id))
        ),
        el("p", { class: "v-occurrences-label" },
          `Affected page${nPages === 1 ? "" : "s"} (${nPages})`
        ),
        el("div", { class: "v-page-groups" }, pageItems)
      )
    );
  }

  // ---- component grouping (experimental) ------------------------------------

  // Identify the code component an occurrence lives in. nyc.gov's new CMS (AEM)
  // marks every component with a `cmp-*` class, so that class IS the component
  // name when present. Otherwise fall back to tag + sorted classes. Coarse on
  // purpose: a bare tag with no classes can merge distinct defects into one
  // group — acceptable for an experiment in remediation-sized grouping, where
  // one group usually maps to one template-level fix.
  function componentFingerprint(html) {
    const cmp = String(html).match(/cmp-[a-z0-9_-]+/i);
    if (cmp) return cmp[0];
    const tag = (String(html).match(/^<([a-z0-9-]+)/i) || [, "element"])[1].toLowerCase();
    const cls = (String(html).match(/class="([^"]*)"/) || [, ""])[1]
      .split(/\s+/).filter(Boolean).sort().slice(0, 3);
    return cls.length ? `${tag}.${cls.join(".")}` : `<${tag}>`;
  }

  // Cluster every occurrence across all pages by (rule × component fingerprint).
  // The same failing search button on 800 pages is one component, not 800
  // problems — the component is the unit of fixing, the way a rule is the unit
  // of understanding.
  function groupByComponent(pages) {
    const byComponent = new Map();
    pages.forEach((p, i) => {
      const label = p.label || pageLabel(p.url, i === 0);
      for (const v of p.violations || []) {
        for (const n of v.nodes || []) {
          const component = componentFingerprint(n.html);
          const key = `${v.id}|${component}`;
          let g = byComponent.get(key);
          if (!g) {
            g = { v, component, key, total: 0, pages: new Map() };
            byComponent.set(key, g);
          }
          g.total++;
          let pg = g.pages.get(p.url);
          if (!pg) {
            pg = { url: p.url, label, count: 0, nodes: [] };
            g.pages.set(p.url, pg);
          }
          pg.count++;
          pg.nodes.push(n);
        }
      }
    });

    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    return [...byComponent.values()]
      .map((g) => ({ ...g, pages: [...g.pages.values()] }))
      .sort((a, b) => {
        const oa = order[a.v.impact] ?? 99, ob = order[b.v.impact] ?? 99;
        if (oa !== ob) return oa - ob;
        return b.total - a.total;
      });
  }

  function componentDomId(key) {
    return "component-" + key.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "");
  }

  function renderGroupedByComponent(pages, totalPages) {
    return el("div", { class: "violations-list" },
      groupByComponent(pages).map((g) => renderComponentGroup(g, totalPages))
    );
  }

  // One 100%-stacked bar above the findings list: each segment is one
  // finding's share of all occurrences on the site, colored by severity and
  // ordered like the list below (severity, then size). Clicking a segment
  // opens and scrolls to its card. Slivers under 1% pool into a gray tail
  // so the bar stays readable.
  function distributionBar(items) {
    const total = items.reduce((s, it) => s + it.count, 0);
    if (!total || items.length < 2) return null;

    const segs = items.filter((it) => (it.count / total) * 100 >= 1);
    const rest = items.length - segs.length;
    const restCount = total - segs.reduce((s, it) => s + it.count, 0);

    const nodes = segs.map((it) => {
      const pct = Math.round((it.count / total) * 100);
      const detail = `${it.label} — ${fmtNum(it.count)} occurrence${it.count === 1 ? "" : "s"} (${pct}%)`;
      return el("button", {
        type: "button",
        class: `dist-seg seg-${it.impact}`,
        style: `flex: ${it.count} 1 0`,
        title: detail,
        "aria-label": `${detail}. Jump to finding.`,
        onclick: () => {
          const target = document.getElementById(it.domId);
          if (!target) return;
          target.open = true;
          target.scrollIntoView({ block: "start", behavior: "smooth" });
          target.classList.add("is-link-target");
          setTimeout(() => target.classList.remove("is-link-target"), 2000);
        },
      },
        pct >= 9 ? el("span", { class: "dist-seg-label" }, `${it.label} · ${pct}%`) : null
      );
    });

    if (restCount > 0) {
      nodes.push(el("div", {
        class: "dist-seg seg-other",
        style: `flex: ${restCount} 1 0`,
        title: `${rest} smaller finding${rest === 1 ? "" : "s"} — ${fmtNum(restCount)} occurrences (${Math.round((restCount / total) * 100)}%)`,
      }));
    }

    return el("div", {
      class: "dist-bar",
      role: "group",
      "aria-label": "Each finding's share of all occurrences on this site",
    }, nodes);
  }

  function renderComponentGroup(g, totalPages) {
    const v = g.v;
    const wcagTag = v.tags.find((t) => /^wcag\d{2,3}$/.test(t));
    const wcagLabel = wcagTag
      ? "WCAG " + wcagTag.replace("wcag", "").split("").join(".")
      : null;
    const nPages = g.pages.length;
    const domId = componentDomId(g.key);

    const showFailure = !sharedFailureSummary(g.pages.flatMap((p) => p.nodes || []));

    const NODE_LIMIT_PER_PAGE = 5;
    const pageItems = g.pages.map((p) => {
      const shown = (p.nodes || []).slice(0, NODE_LIMIT_PER_PAGE);
      const remaining = (p.nodes || []).length - shown.length;
      return el("details", { class: "v-page-group" },
        el("summary", { class: "v-page-header" },
          el("div", { class: "v-page-label", title: p.label }, p.label),
          el("div", { class: "v-page-meta" },
            `${fmtNum(p.count)} occurrence${p.count === 1 ? "" : "s"} · `,
            el("a", { href: p.url, target: "_blank", rel: "noopener",
              title: p.url, onclick: (e) => e.stopPropagation() }, "Open ↗")
          )
        ),
        el("ul", { class: "v-nodes" },
          shown.map((n) => renderNode(n, p.url, showFailure)),
          remaining > 0
            ? el("li", { class: "v-nodes-more" },
                `+ ${fmtNum(remaining)} more occurrence${remaining === 1 ? "" : "s"} on this page`)
            : null
        )
      );
    });

    return el("details", { class: "violation", id: domId },
      el("summary", {},
        el("span", { class: `v-impact imp-${v.impact}` }, v.impact),
        el("div", { class: "v-headline" },
          el("p", { class: "v-help" },
            el("code", { class: "v-component-name" }, g.component)
          ),
          el("p", { class: "v-explain" }, v.help),
          el("div", { class: "v-meta" },
            el("span", { class: "v-rule-id" }, v.id),
            wcagLabel ? el("span", { class: "v-wcag" }, wcagLabel) : null,
            el("span", { class: "v-pages-badge" },
              `on ${nPages} of ${totalPages} page${totalPages === 1 ? "" : "s"}`)
          )
        ),
        el("div", { class: "v-count" },
          el("strong", {}, fmtNum(g.total)), " ",
          g.total === 1 ? "occurrence" : "occurrences"
        )
      ),
      el("div", { class: "v-body" },
        explanationBlock(v.id),
        el("div", { class: "v-actions-row" },
          el("a", { class: "v-fix", href: v.helpUrl, target: "_blank", rel: "noopener" },
            "How to fix",
            el("span", { class: "v-fix-arrow" }, "→")
          ),
          permalinkButton(domId)
        ),
        el("p", { class: "v-occurrences-label" },
          `Affected page${nPages === 1 ? "" : "s"} (${nPages})`
        ),
        el("div", { class: "v-page-groups" }, pageItems)
      )
    );
  }

  // The rule view answers "what's wrong"; the component view answers "what do
  // we fix". Both render the same occurrences — only the grouping differs.
  function viewToggle(siteName, view) {
    // In-place switch: pushState + re-render rather than a navigation, so the
    // page doesn't reload. Real hrefs are kept for middle-click / copy-link,
    // and popstate (back/forward) re-routes.
    const mk = (val, label) => el("a", {
      class: "view-toggle-btn" + (view === val ? " is-active" : ""),
      href: `?site=${encodeURIComponent(siteName)}` + (val === "components" ? "&view=components" : ""),
      "aria-current": view === val ? "page" : null,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (view === val) return;
        history.pushState(null, "", e.currentTarget.getAttribute("href"));
        route();
        announce(label === "By rule" ? "Findings grouped by rule" : "Findings grouped by component");
      },
    }, label);
    return el("nav", { class: "view-toggle", "aria-label": "Group findings" },
      mk("rules", "By rule"),
      mk("components", "By component")
    );
  }

  function renderHistoryChart(siteName) {
    const history = window.HISTORY_DATA;
    if (!history || !window.Chart) return null;
    const entries = history
      .filter((h) => h.site === siteName && h.crawlComplete)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (entries.length === 0) return null;

    const labels = entries.map((e) => {
      const d = new Date(e.date);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    });
    const severities = ["critical", "serious", "moderate", "minor"];
    // Lines carry the data; fills are whispers. Saturated area fill was the
    // single biggest mass of red on the page and encoded nothing the lines
    // don't. Serious is rust (matches --imp-serious) — critical is the only
    // true red on the dashboard.
    const colors = {
      critical: { line: "rgb(125, 6, 6)",    fill: "rgba(125, 6, 6, 0.07)" },
      serious:  { line: "rgb(156, 74, 6)",   fill: "rgba(156, 74, 6, 0.07)" },
      moderate: { line: "rgb(139, 94, 26)",  fill: "rgba(139, 94, 26, 0.06)" },
      minor:    { line: "rgb(67, 107, 149)", fill: "rgba(67, 107, 149, 0.05)" },
    };
    const datasets = severities.map((sev) => ({
      label: sev.charAt(0).toUpperCase() + sev.slice(1),
      data: entries.map((e) =>
        e.rules.filter((r) => r.impact === sev).reduce((s, r) => s + r.count, 0)
      ),
      backgroundColor: colors[sev].fill,
      borderColor: colors[sev].line,
      borderWidth: 2,
      fill: true,
    }));

    // Canvas is opaque to assistive tech, so describe the chart as an image:
    // the span of scans plus the latest reading per severity. Screen-reader
    // users get the same takeaway a sighted user reads off the lines.
    const latest = datasets
      .map((d) => `${d.data[d.data.length - 1]} ${d.label.toLowerCase()}`)
      .join(", ");
    const chartAlt = entries.length === 1
      ? `Trend chart for ${siteName}. One scan on ${labels[0]}: ${latest} occurrences.`
      : `Trend chart for ${siteName}: occurrences by severity across ${entries.length} scans, ${labels[0]} to ${labels[labels.length - 1]}. Latest scan: ${latest}.`;

    const canvas = el("canvas", { width: "800", height: "260", role: "img", "aria-label": chartAlt });
    const wrap = el("section", { class: "history-chart" },
      sectionEyebrow("Trend", "Occurrences by severity over time"),
      canvas
    );

    requestAnimationFrame(() => {
      new Chart(canvas, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
          },
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 12 } },
          },
          elements: {
            line: { tension: 0 },
            point: { radius: 3 },
          },
        },
      });
    });

    return wrap;
  }

  function renderDetail(siteName) {
    const back = el("a", { class: "detail-back", href: "?" },
      el("span", { class: "arrow" }, "←"), " All agencies"
    );

    const site = data.sites.find((s) => s.name === siteName);
    if (!site) {
      app.replaceChildren(back, el("div", { class: "error-banner" },
        el("p", { class: "error-banner-label" }, "Not found"),
        el("p", { class: "error-banner-body" }, `Site "${siteName}" not found in scan data.`)
      ));
      return;
    }

    const pages = site.pages || [site];
    const numPages = pages.length;

    const header = el("section", { class: "detail-header" },
      el("div", {},
        el("div", { class: "detail-header-titlerow" },
          el("h2", { class: "detail-header-title" }, site.name),
          tierPill(siteTier(site))
        ),
        el("div", { class: "detail-header-url" },
          el("a", { href: site.url, target: "_blank", rel: "noopener" }, site.url)
        )
      ),
      site.error
        ? null
        : el("div", { class: "detail-header-stats" },
            statBlock(fmtNum(site.total_violations), "Violations"),
            statBlock(fmtNum(site.distinct_rules), "Distinct rules"),
            numPages > 1 ? statBlock(String(numPages), "Pages") : null,
            statBlock(fmtDuration(site.scan_ms), "Scan time")
          )
    );

    if (site.error) {
      app.replaceChildren(back, header, el("div", { class: "error-banner" },
        el("p", { class: "error-banner-label" }, "Scan error"),
        el("p", { class: "error-banner-body" }, site.error)
      ));
      return;
    }

    const allViolations = siteViolations(site);
    if (allViolations.length === 0) {
      app.replaceChildren(back, header,
        methodologyCallout(false),
        el("div", { class: "empty-state" },
          el("p", { class: "empty-state-title" }, "No automated violations found"),
          el("p", { class: "empty-state-body" },
            "Floor check passed against WCAG 2.2 AA. Manual review and assistive-technology testing are still required to confirm full compliance — automated scanners detect only a portion of accessibility failures."
          )
        )
      );
      return;
    }

    const view = new URLSearchParams(location.search).get("view") === "components"
      ? "components" : "rules";

    const findingsLabel = view === "components"
      ? (() => {
          const groups = groupByComponent(pages);
          const critical = groups.filter((g) => g.v.impact === "critical").length;
          return `${groups.length} component${groups.length === 1 ? "" : "s"}` +
            (critical ? ` · ${critical} with critical issues` : "") +
            ` · ${fmtNum(site.total_violations)} occurrence${site.total_violations === 1 ? "" : "s"}`;
        })()
      : numPages > 1
      ? `${site.distinct_rules} rule${site.distinct_rules === 1 ? "" : "s"} failed across ${numPages} pages · ${fmtNum(site.total_violations)} occurrence${site.total_violations === 1 ? "" : "s"}`
      : `${allViolations.length} rule${allViolations.length === 1 ? "" : "s"} failed · ${fmtNum(site.total_violations)} occurrence${site.total_violations === 1 ? "" : "s"}`;

    const historyChart = renderHistoryChart(site.name);
    const children = [back, header, methodologyCallout(false)];
    if (historyChart) children.push(historyChart);
    children.push(el("div", { class: "section-eyebrow findings-head" },
      el("h2", { class: "section-eyebrow-title" }, "Findings"),
      el("p", { class: "section-eyebrow-sub" }, findingsLabel),
      viewToggle(site.name, view)
    ));

    if (view === "components") {
      const groups = groupByComponent(pages);
      children.push(distributionBar(groups.map((g) => ({
        domId: componentDomId(g.key), label: g.component, impact: g.v.impact, count: g.total,
      }))));
      children.push(renderGroupedByComponent(pages, numPages));
    } else if (numPages > 1) {
      const groups = groupByRule(pages);
      children.push(distributionBar(groups.map((g) => ({
        domId: findingDomId(g.v.id), label: g.v.id, impact: g.v.impact, count: g.total,
      }))));
      children.push(renderGroupedByRule(pages, numPages));
    } else {
      const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      const sorted = [...allViolations].sort((a, b) => {
        const oa = order[a.impact] ?? 99, ob = order[b.impact] ?? 99;
        if (oa !== ob) return oa - ob;
        return b.nodes.length - a.nodes.length;
      });
      children.push(distributionBar(sorted.map((v) => ({
        domId: findingDomId(v.id), label: v.id, impact: v.impact, count: v.nodes.length,
      }))));
      children.push(el("div", { class: "violations-list" }, sorted.map((v) => renderViolation(v, site.url))));
    }

    // distributionBar returns null when there's nothing worth charting
    app.replaceChildren(...children.filter(Boolean));
  }

  function renderViolation(v, pageUrl) {
    const wcagTag = v.tags.find((t) => /^wcag\d{2,3}$/.test(t));
    const wcagLabel = wcagTag
      ? "WCAG " + wcagTag.replace("wcag", "").split("").join(".")
      : null;

    const showFailure = !sharedFailureSummary(v.nodes);
    const NODE_LIMIT = 10;
    const occurrences = v.nodes.slice(0, NODE_LIMIT).map((n) => renderNode(n, pageUrl, showFailure));
    if (v.nodes.length > NODE_LIMIT) {
      occurrences.push(
        el("li", { class: "v-nodes-more" }, `+ ${fmtNum(v.nodes.length - NODE_LIMIT)} more occurrence${v.nodes.length - NODE_LIMIT === 1 ? "" : "s"}`)
      );
    }

    return el("details", { class: "violation", id: findingDomId(v.id) },
      el("summary", {},
        el("span", { class: `v-impact imp-${v.impact}` }, v.impact),
        el("div", { class: "v-headline" },
          el("p", { class: "v-help" }, v.help),
          ruleExplain(v),
          el("div", { class: "v-meta" },
            el("span", { class: "v-rule-id" }, v.id),
            wcagLabel ? el("span", { class: "v-wcag" }, wcagLabel) : null
          )
        ),
        el("div", { class: "v-count" },
          el("strong", {}, fmtNum(v.nodes.length)), " ",
          v.nodes.length === 1 ? "occurrence" : "occurrences"
        )
      ),
      el("div", { class: "v-body" },
        explanationBlock(v.id),
        el("div", { class: "v-actions-row" },
          el("a", { class: "v-fix", href: v.helpUrl, target: "_blank", rel: "noopener" },
            "How to fix",
            el("span", { class: "v-fix-arrow" }, "→")
          ),
          permalinkButton(findingDomId(v.id))
        ),
        el("p", { class: "v-occurrences-label" },
          v.nodes.length === 1 ? "Occurrence" : `Occurrences (${fmtNum(Math.min(v.nodes.length, 10))} of ${fmtNum(v.nodes.length)})`
        ),
        el("ul", { class: "v-nodes" }, occurrences)
      )
    );
  }

  // ---- per-page detail ------------------------------------------------------

  // Page detail inverts the site-detail grouping: instead of "this rule → which
  // pages it broke on", we show "this page → which rules failed on it". Same
  // node renderer as the single-page site path (selector + locate script +
  // open page). Route: ?page=<full-encoded-url>; the site is derived by
  // looking up the URL in the dataset.
  function renderPageDetail(pageUrl) {
    const overviewBack = el("a", { class: "detail-back", href: "?" },
      el("span", { class: "arrow" }, "←"), " All agencies"
    );

    const found = findPageByUrl(data, pageUrl);
    if (!found) {
      app.replaceChildren(overviewBack, el("div", { class: "error-banner" },
        el("p", { class: "error-banner-label" }, "Page not found"),
        el("p", { class: "error-banner-body" },
          `No scan data for ${pageUrl}. The URL may not have been included in the last crawl, or it may be misspelled.`
        )
      ));
      return;
    }

    const { site, page } = found;
    const pagePath = (() => {
      try { return new URL(page.url).pathname.replace(/\/$/, "") || "/"; }
      catch { return page.url; }
    })();
    const tier = tierFromCounts(page.counts);
    const violations = page.violations || [];
    const occurrences = violations.reduce((sum, v) => sum + v.nodes.length, 0);

    const siteBack = el("a", { class: "detail-back", href: `?site=${encodeURIComponent(site.name)}` },
      el("span", { class: "arrow" }, "←"), " ", site.name
    );

    const header = el("section", { class: "detail-header" },
      el("div", {},
        el("div", { class: "detail-header-eyebrow" }, site.name, " · Page detail"),
        el("div", { class: "detail-header-titlerow" },
          el("h2", { class: "detail-header-title page-detail-title" }, pagePath),
          tierPill(tier)
        ),
        el("div", { class: "detail-header-url" },
          el("a", { href: page.url, target: "_blank", rel: "noopener" }, page.url)
        )
      ),
      el("div", { class: "detail-header-stats" },
        statBlock(fmtNum(occurrences), occurrences === 1 ? "Occurrence" : "Occurrences"),
        statBlock(fmtNum(violations.length), violations.length === 1 ? "Rule failed" : "Rules failed"),
        page.scan_ms ? statBlock(fmtDuration(page.scan_ms), "Scan time") : null
      )
    );

    const children = [
      el("div", { class: "detail-back-row" }, overviewBack, siteBack),
      header,
      methodologyCallout(false),
    ];

    if (violations.length === 0) {
      children.push(el("div", { class: "empty-state" },
        el("p", { class: "empty-state-title" }, "No automated violations on this page"),
        el("p", { class: "empty-state-body" },
          "Floor check passed for this URL against WCAG 2.2 AA. Manual review and assistive-technology testing are still required to confirm full compliance."
        )
      ));
      app.replaceChildren(...children);
      return;
    }

    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const sorted = [...violations].sort((a, b) => {
      const oa = order[a.impact] ?? 99, ob = order[b.impact] ?? 99;
      if (oa !== ob) return oa - ob;
      return b.nodes.length - a.nodes.length;
    });

    children.push(
      sectionEyebrow("Findings",
        `${violations.length} rule${violations.length === 1 ? "" : "s"} failed on this page · ${fmtNum(occurrences)} occurrence${occurrences === 1 ? "" : "s"}`
      ),
      el("div", { class: "violations-list" }, sorted.map((v) => renderViolation(v, page.url)))
    );

    app.replaceChildren(...children);
  }

  // ---- header meta + footer + route ----------------------------------------

  footerMeta.textContent = `Engine: ${data.engine} · Target: ${data.wcag_target} · Last scan: ${fmtDate(data.scanned_at)}`;

  function route() {
    const params = new URLSearchParams(location.search);
    const pageParam = params.get("page");
    const siteParam = params.get("site");
    // Detail/page views are text-heavy (findings, explanations) and read better
    // at a tighter measure; the overview keeps the full width for its wide table.
    app.classList.toggle("page-narrow", !!(pageParam || siteParam));
    if (pageParam) renderPageDetail(pageParam);
    else if (siteParam) renderDetail(siteParam);
    else renderOverview();
  }

  route();
  window.addEventListener("popstate", route);

  applyHashTarget();
  window.addEventListener("hashchange", applyHashTarget);
})();
