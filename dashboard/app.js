// app.js — render SCAN_DATA into either an overview or per-site detail view.
//
// View routing: `?site=<name>` shows the detail view; otherwise overview.
// No router, no framework. Plain DOM building.

(function () {
  "use strict";

  const data = window.SCAN_DATA;
  const app = document.getElementById("app");
  const footerMeta = document.getElementById("footer-meta");

  if (!data || !Array.isArray(data.sites)) {
    app.innerHTML = `<article><strong>No scan data found.</strong> Run <code>node scan.js</code> from the project root, then reload.</article>`;
    return;
  }

  // ---- helpers --------------------------------------------------------------

  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleString(); }
    catch { return iso; }
  };

  const tierLabel = {
    red:    "Needs work",
    yellow: "Some issues",
    green:  "No automated violations",
    error:  "Scan error",
  };

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

  function tierPill(tier) {
    return el("span", { class: `tier ${tier}` }, tierLabel[tier] || tier);
  }

  function impactChip(impact, count) {
    if (count === 0) return null;
    return el("span", { class: `impact has-${impact}` }, `${count} ${impact}`);
  }

  // ---- overview -------------------------------------------------------------

  function renderOverview() {
    const sites = data.sites;
    const tiers = { red: 0, yellow: 0, green: 0, error: 0 };
    let totalIssues = 0;
    let totalRules = 0;
    for (const s of sites) {
      tiers[s.tier]++;
      totalIssues += s.total_violations;
      totalRules  += s.distinct_rules;
    }

    // Summary stats
    const summary = el("section", { class: "overview-summary" },
      el("div", { class: "stat" },
        el("span", { class: "num" }, String(sites.length)),
        el("span", { class: "lbl" }, "sites scanned")
      ),
      el("div", { class: "stat" },
        el("span", { class: "num" }, String(totalIssues)),
        el("span", { class: "lbl" }, "total violations")
      ),
      el("div", { class: "stat" },
        el("span", { class: "num", style: "color: var(--tier-red)" }, String(tiers.red)),
        el("span", { class: "lbl" }, "needs work")
      ),
      el("div", { class: "stat" },
        el("span", { class: "num", style: "color: var(--tier-yellow)" }, String(tiers.yellow)),
        el("span", { class: "lbl" }, "some issues")
      ),
      el("div", { class: "stat" },
        el("span", { class: "num", style: "color: var(--tier-green)" }, String(tiers.green)),
        el("span", { class: "lbl" }, "clean")
      ),
    );

    // Site cards — one per site, links to detail view
    const cards = sites.map((s) => {
      const topRule = s.violations[0]; // already sorted by impact severity from axe
      const card = el("a",
        { class: "site-card", href: `?site=${encodeURIComponent(s.name)}` },
        el("h3", {}, s.name, " ", tierPill(s.tier)),
        el("div", { class: "url" }, s.url),
        s.error
          ? el("div", { class: "error-banner" }, `Scan error: ${s.error}`)
          : el("div", { class: "impact-row" },
              impactChip("critical", s.counts.critical),
              impactChip("serious",  s.counts.serious),
              impactChip("moderate", s.counts.moderate),
              impactChip("minor",    s.counts.minor),
              s.total_violations === 0 ? el("span", { class: "impact" }, "no violations") : null,
            ),
        topRule
          ? el("p", { class: "top-rule" }, `Top: ${topRule.id} (${topRule.nodes.length}×)`)
          : null,
      );
      return card;
    });

    app.replaceChildren(
      summary,
      el("section", { class: "site-grid" }, cards),
    );
  }

  // ---- per-site detail ------------------------------------------------------

  function renderDetail(siteName) {
    const site = data.sites.find((s) => s.name === siteName);
    if (!site) {
      app.replaceChildren(
        el("article", {}, `Site "${siteName}" not found in scan data. `,
          el("a", { href: "?" }, "Back to overview")),
      );
      return;
    }

    const header = el("section", { class: "detail-header" },
      el("div", {},
        el("a", { class: "back-link", href: "?" }, "← all sites"),
        el("h2", {}, site.name, " ", tierPill(site.tier)),
        el("div", { class: "detail-meta" },
          el("a", { href: site.url, target: "_blank", rel: "noopener" }, site.url),
          ` · ${site.total_violations} violations across ${site.distinct_rules} distinct rules · scan took ${site.scan_ms}ms`,
        ),
      ),
    );

    if (site.error) {
      app.replaceChildren(header, el("div", { class: "error-banner" }, `Scan error: ${site.error}`));
      return;
    }

    if (site.violations.length === 0) {
      app.replaceChildren(header,
        el("article", {}, "No automated WCAG 2.2 AA violations found. ",
          el("strong", {}, "This is a floor check, not a certification — manual review and assistive-tech testing are still required.")));
      return;
    }

    // Sort violations: critical > serious > moderate > minor, then by occurrence count desc
    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const sorted = [...site.violations].sort((a, b) => {
      const oa = order[a.impact] ?? 99, ob = order[b.impact] ?? 99;
      if (oa !== ob) return oa - ob;
      return b.nodes.length - a.nodes.length;
    });

    const violationEls = sorted.map((v) => {
      const wcagTag = v.tags.find((t) => /^wcag\d{2,3}$/.test(t)); // e.g. "wcag111", "wcag143"
      const wcagLabel = wcagTag
        ? "WCAG " + wcagTag.replace("wcag", "").split("").join(".")
        : null;

      return el("details", { class: "violation" },
        el("summary", {},
          el("span", { class: `rule-impact ${v.impact}` }, v.impact),
          el("span", { class: "rule-id" }, v.id),
          wcagLabel ? el("span", { class: "rule-tag" }, wcagLabel) : null,
          el("span", { class: "count" }, `${v.nodes.length} occurrence${v.nodes.length === 1 ? "" : "s"}`),
        ),
        el("p", { class: "desc" }, v.help, ". ",
          el("a", { href: v.helpUrl, target: "_blank", rel: "noopener" }, "How to fix →")),
        el("ul", { class: "nodes" },
          v.nodes.slice(0, 10).map((n) =>
            el("li", {},
              el("div", { class: "selector" }, Array.isArray(n.target) ? n.target.join(" ") : String(n.target)),
              el("code", { class: "html" }, n.html),
            )
          ),
          v.nodes.length > 10
            ? el("li", { class: "html" }, `… and ${v.nodes.length - 10} more`)
            : null,
        ),
      );
    });

    app.replaceChildren(header, el("section", {}, violationEls));
  }

  // ---- footer + route -------------------------------------------------------

  footerMeta.textContent = `Engine: ${data.engine} · Target: ${data.wcag_target} · Last scan: ${fmtTime(data.scanned_at)}`;

  const params = new URLSearchParams(location.search);
  const siteParam = params.get("site");
  if (siteParam) renderDetail(siteParam);
  else renderOverview();
})();
