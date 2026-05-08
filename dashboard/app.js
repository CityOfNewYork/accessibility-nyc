// app.js — render SCAN_DATA into either an overview or per-site detail view.
//
// View routing: `?site=<name>` shows detail; otherwise overview.
// No router, no framework. Plain DOM building.

(function () {
  "use strict";

  const data = window.SCAN_DATA;
  const app = document.getElementById("app");
  const footerMeta = document.getElementById("footer-meta");
  const metaScannedAt = document.getElementById("meta-scanned-at");

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

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch { return iso; }
  }

  const tierLabel = {
    red:    "Needs work",
    yellow: "Some issues",
    green:  "Clean",
    error:  "Scan error",
  };
  const tierClass = {
    red:    "tier-red",
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
            ", the standard set by the NYC Digital Design System.")
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

  // ---- overview -------------------------------------------------------------

  function renderOverview() {
    const sites = data.sites;
    const tiers = { red: 0, yellow: 0, green: 0, error: 0 };
    let totalIssues = 0, totalRules = 0;
    for (const s of sites) {
      tiers[s.tier]++;
      totalIssues += s.total_violations;
      totalRules += s.distinct_rules;
    }

    const summary = el("section", { class: "summary-strip" },
      summaryCell("Sites scanned", String(sites.length)),
      summaryCell("Violations", fmtNum(totalIssues), `${totalRules} distinct rules`),
      summaryCell("Needs work", String(tiers.red), null, "is-red"),
      summaryCell("Some issues", String(tiers.yellow), null, "is-amber"),
      summaryCell("Clean", String(tiers.green), tiers.error ? `${tiers.error} scan error${tiers.error === 1 ? "" : "s"}` : null, "is-green"),
    );

    const headerRow = el("tr", {},
      el("th", {}, "Agency"),
      el("th", {}, "Tier"),
      el("th", { class: "numeric" }, "Issues"),
      el("th", {}, "By impact"),
      el("th", { class: "top-rule-col" }, "Top rule"),
      el("th", { class: "numeric top-rule-col" }, "Scan time")
    );

    const rows = sites.map((s) => {
      const link = `?site=${encodeURIComponent(s.name)}`;
      const tr = el("tr", {
        onclick: (e) => {
          if (e.target.closest("a")) return; // let the explicit link handle itself
          location.href = link;
        }
      },
        el("td", {},
          el("a", { class: "site-name", href: link }, s.name),
          el("div", { class: "site-url" }, s.url)
        ),
        el("td", {}, tierPill(s.tier)),
        el("td", { class: "numeric" }, s.error ? "—" : fmtNum(s.total_violations)),
        el("td", {},
          s.error
            ? el("span", { class: "impact-chip imp-none" }, el("span", { class: "lbl" }, "Error"))
            : impactRow(s.counts)
        ),
        el("td", { class: "top-rule-cell top-rule-col" },
          s.violations[0]
            ? [s.violations[0].id, el("span", { class: "count" }, `(${s.violations[0].nodes.length}×)`)]
            : "—"
        ),
        el("td", { class: "numeric top-rule-cell top-rule-col" }, s.error ? "—" : `${fmtNum(s.scan_ms)} ms`)
      );
      return tr;
    });

    const sitesTable = el("div", { class: "sites-table-wrap" },
      el("table", { class: "sites-table" },
        el("thead", {}, headerRow),
        el("tbody", {}, rows)
      )
    );

    app.replaceChildren(
      methodologyCallout(true),
      summary,
      sectionEyebrow("Agency homepages", `${sites.length} scanned · click a row for details`),
      sitesTable
    );
  }

  // ---- per-site detail ------------------------------------------------------

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

    const header = el("section", { class: "detail-header" },
      el("div", {},
        el("div", { class: "detail-header-titlerow" },
          el("h2", { class: "detail-header-title" }, site.name),
          tierPill(site.tier)
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
            statBlock(`${fmtNum(site.scan_ms)} ms`, "Scan time")
          )
    );

    if (site.error) {
      app.replaceChildren(back, header, el("div", { class: "error-banner" },
        el("p", { class: "error-banner-label" }, "Scan error"),
        el("p", { class: "error-banner-body" }, site.error)
      ));
      return;
    }

    if (site.violations.length === 0) {
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

    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const sorted = [...site.violations].sort((a, b) => {
      const oa = order[a.impact] ?? 99, ob = order[b.impact] ?? 99;
      if (oa !== ob) return oa - ob;
      return b.nodes.length - a.nodes.length;
    });

    const violationEls = sorted.map(renderViolation);

    app.replaceChildren(
      back,
      header,
      methodologyCallout(false),
      sectionEyebrow("Findings",
        `${site.violations.length} rule${site.violations.length === 1 ? "" : "s"} failed · ${fmtNum(site.total_violations)} occurrence${site.total_violations === 1 ? "" : "s"}`),
      el("div", { class: "violations-list" }, violationEls)
    );
  }

  function renderViolation(v) {
    const wcagTag = v.tags.find((t) => /^wcag\d{2,3}$/.test(t));
    const wcagLabel = wcagTag
      ? "WCAG " + wcagTag.replace("wcag", "").split("").join(".")
      : null;

    const occurrences = v.nodes.slice(0, 10).map((n) =>
      el("li", {},
        el("span", { class: "v-selector" }, Array.isArray(n.target) ? n.target.join(" ") : String(n.target)),
        el("span", { class: "v-html" }, n.html)
      )
    );
    if (v.nodes.length > 10) {
      occurrences.push(
        el("li", { class: "more" }, `+ ${fmtNum(v.nodes.length - 10)} more occurrence${v.nodes.length - 10 === 1 ? "" : "s"}`)
      );
    }

    return el("details", { class: "violation" },
      el("summary", {},
        el("span", { class: `v-impact imp-${v.impact}` }, v.impact),
        el("div", { class: "v-headline" },
          el("p", { class: "v-help" }, v.help),
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
        el("a", { class: "v-fix", href: v.helpUrl, target: "_blank", rel: "noopener" },
          "How to fix",
          el("span", { class: "v-fix-arrow" }, "→")
        ),
        el("p", { class: "v-occurrences-label" },
          v.nodes.length === 1 ? "Occurrence" : `Occurrences (${fmtNum(Math.min(v.nodes.length, 10))} of ${fmtNum(v.nodes.length)})`
        ),
        el("ul", { class: "v-occurrences" }, occurrences)
      )
    );
  }

  // ---- header meta + footer + route ----------------------------------------

  if (metaScannedAt) metaScannedAt.textContent = fmtDate(data.scanned_at);
  footerMeta.textContent = `Engine: ${data.engine} · Target: ${data.wcag_target} · Last scan: ${fmtDate(data.scanned_at)}`;

  const params = new URLSearchParams(location.search);
  const siteParam = params.get("site");
  if (siteParam) renderDetail(siteParam);
  else renderOverview();
})();
