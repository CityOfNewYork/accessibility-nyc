// links-app.js — render LINKS_DATA into an overview or per-site link-health view.
//
// Sibling of app.js, deliberately kept separate and lean: this is the
// broken-link checker, NOT the accessibility scan. Link health is never a WCAG
// verdict, so nothing here reuses the a11y tiers. Three lanes only:
//   broken (red) · needs-review (amber) · ok (green)
//
// View routing: `?site=<name>` shows detail; otherwise the overview. No router,
// no framework — plain DOM building, reusing styles.css from the a11y dashboard.

(function () {
  "use strict";

  const data = window.LINKS_DATA;
  const app = document.getElementById("app");
  const footerMeta = document.getElementById("footer-meta");

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
      return new Date(iso).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      });
    } catch { return iso; }
  }

  if (!data || !Array.isArray(data.sites)) {
    app.innerHTML = `<div class="error-banner">
      <p class="error-banner-label">No link data</p>
      <p class="error-banner-body">Run <code>node scan.js --collect-links</code> then <code>node check-links.mjs</code>, and reload.</p>
    </div>`;
    return;
  }

  // broken (red) · review (amber) · ok (green) → reuse the a11y tier color tokens.
  const STATE_TIER = { broken: "red", review: "amber", ok: "green" };
  const STATE_LABEL = { broken: "Broken", review: "Needs review", ok: "OK" };

  function tierPill(state, text) {
    return el("span", { class: `tier-pill tier-${STATE_TIER[state]}` }, text ?? STATE_LABEL[state]);
  }

  // Short, human label for why a link is in its lane.
  const ERR_LABEL = {
    TIMEOUT: "timed out",
    REDIRECT_LOOP: "redirect loop",
    ENOTFOUND: "host not found",
    ECONNREFUSED: "connection refused",
    NETWORK: "network error",
  };
  function statusLabel(link) {
    if (link.error) return ERR_LABEL[link.error] ?? link.error.toLowerCase();
    if (link.status) return `HTTP ${link.status}`;
    return "no response";
  }

  function totals() {
    return data.sites.reduce(
      (a, s) => ({
        broken: a.broken + s.counts.broken,
        review: a.review + s.counts.review,
        ok: a.ok + s.counts.ok,
      }),
      { broken: 0, review: 0, ok: 0 }
    );
  }

  function setFooter() {
    if (!footerMeta) return;
    const t = totals();
    footerMeta.textContent =
      `Checked ${fmtNum(data.total_urls ?? 0)} unique URL(s) · ` +
      `${fmtNum(t.broken)} broken · ${fmtNum(t.review)} needs-review · ${fmtNum(t.ok)} ok` +
      (data.checked_at ? ` · ${fmtDate(data.checked_at)}` : "");
  }

  // ---- overview -------------------------------------------------------------

  function summaryStrip(t) {
    const cell = (label, value, cls, sub) =>
      el("div", { class: "summary-cell" },
        el("div", { class: "summary-cell-label" }, label),
        el("div", { class: `summary-cell-value ${cls}` }, fmtNum(value)),
        sub && el("div", { class: "summary-cell-sub" }, sub)
      );
    return el("div", { class: "summary-strip" },
      cell("Broken", t.broken, "is-red", "confirmed dead"),
      cell("Needs review", t.review, "is-amber", "couldn't verify"),
      cell("OK", t.ok, "is-green", "reachable")
    );
  }

  function reviewNote() {
    return el("p", { class: "lh-note" },
      el("strong", {}, "Needs review"),
      " links returned a block (403 / rate-limit), timed out, or point to a host that " +
      "refuses automated checks (social platforms). They are not confirmed broken — a human should glance at them."
    );
  }

  function renderOverview() {
    app.replaceChildren();
    app.append(summaryStrip(totals()), reviewNote());

    const rows = data.sites
      .slice()
      .sort((a, b) => b.counts.broken - a.counts.broken || b.counts.review - a.counts.review)
      .map((s) => {
        const total = s.counts.broken + s.counts.review + s.counts.ok;
        const href = `?site=${encodeURIComponent(s.name)}`;
        const cell = (n, state) =>
          el("td", { class: "lh-num" },
            n ? tierPill(state, fmtNum(n)) : el("span", { class: "lh-zero" }, "0"));
        return el("tr", { onclick: () => { location.search = href; }, style: "cursor:pointer;" },
          el("td", {}, el("a", { href }, s.name)),
          cell(s.counts.broken, "broken"),
          cell(s.counts.review, "review"),
          el("td", { class: "lh-num" }, tierPill("ok", fmtNum(s.counts.ok))),
          el("td", { class: "lh-total" }, fmtNum(total))
        );
      });

    const table = el("div", { class: "sites-table-wrap" },
      el("table", { class: "sites-table" },
        el("thead", {},
          el("tr", {},
            el("th", {}, "Site"),
            el("th", { class: "lh-num" }, "Broken"),
            el("th", { class: "lh-num" }, "Needs review"),
            el("th", { class: "lh-num" }, "OK"),
            el("th", { class: "lh-num" }, "Total")
          )
        ),
        el("tbody", {}, rows)
      )
    );
    app.append(table);
    setFooter();
  }

  // ---- per-site detail ------------------------------------------------------

  function sourceDetails(link) {
    const pages = link.pages || [];
    const total = link.page_count ?? pages.length;
    const extra = total - pages.length;
    return el("details", { class: "lh-sources" },
      el("summary", {}, ` Linked from ${fmtNum(total)} page${total === 1 ? "" : "s"}`),
      el("ul", {},
        pages.map((p) =>
          el("li", {}, el("a", { href: p, target: "_blank", rel: "noopener" }, p.replace(/^https?:\/\//, "")))
        ),
        extra > 0 ? el("li", { class: "lh-sources-more" }, `+${fmtNum(extra)} more`) : null
      )
    );
  }

  function linkRow(link) {
    return el("li", { class: "lh-item" },
      el("div", { class: "lh-head" },
        tierPill(link.state, statusLabel(link)),
        el("span", { class: "lh-url" },
          el("a", { href: link.href, target: "_blank", rel: "noopener", title: link.href }, link.href)
        ),
        el("span", { class: "lh-kind" }, link.kind),
        link.via === "browser" ? el("span", { class: "lh-via", title: "Re-checked in a real browser; still couldn't load" }, "browser-checked") : null
      ),
      link.text ? el("p", { class: "lh-text" }, `“${link.text}”`) : null,
      link.redirected_to ? el("p", { class: "lh-redirect", title: link.redirected_to }, `→ ${link.redirected_to}`) : null,
      sourceDetails(link)
    );
  }

  function section(title, links, note) {
    if (!links.length) return null;
    return el("section", { style: "margin-top:2.25rem;" },
      el("div", { class: "section-eyebrow" },
        el("span", { class: "section-eyebrow-title" }, `${title} `),
        el("span", { class: "section-eyebrow-sub" }, `(${fmtNum(links.length)})`)
      ),
      note ? el("p", { class: "lh-note" }, note) : null,
      el("ul", { class: "lh-list" }, links.map(linkRow))
    );
  }

  function renderDetail(site) {
    app.replaceChildren();
    app.append(
      el("div", { class: "detail-back-row" },
        el("a", { class: "detail-back", href: "links.html" }, "← All sites")
      ),
      el("div", { class: "detail-header" },
        el("div", { class: "detail-header-eyebrow" }, "Link health"),
        el("div", { class: "detail-header-titlerow" },
          el("h2", { class: "detail-header-title" }, site.name)
        ),
        el("a", { class: "detail-header-url", href: site.url, target: "_blank", rel: "noopener" }, site.url),
        el("div", { class: "detail-header-stats" },
          statCell(site.counts.broken, "Broken", "is-red"),
          statCell(site.counts.review, "Needs review", "is-amber"),
          statCell(site.counts.ok, "OK", "is-green")
        )
      )
    );

    const broken = site.links.filter((l) => l.state === "broken");
    const review = site.links.filter((l) => l.state === "review");

    if (!broken.length && !review.length) {
      app.append(el("div", { class: "empty-state" },
        el("div", { class: "empty-state-title" }, "No broken or unverifiable links"),
        el("div", { class: "empty-state-body" }, `All ${fmtNum(site.counts.ok)} checked link(s) on ${site.name} resolved.`)
      ));
    } else {
      // .append coerces null to a "null" text node, so drop empty sections.
      app.append(...[
        section("Broken", broken),
        section("Needs review", review,
          "Returned a block (403 / rate-limit), timed out, or sit on a host that refuses automated checks (social platforms). Not confirmed broken — verify by hand."),
      ].filter(Boolean));
    }
    setFooter();
  }

  function statCell(value, label, cls) {
    return el("div", {},
      el("div", { class: `detail-header-stat-num ${cls}` }, fmtNum(value)),
      el("div", { class: "detail-header-stat-lbl" }, label)
    );
  }

  // ---- route ----------------------------------------------------------------

  function route() {
    const params = new URLSearchParams(location.search);
    const siteName = params.get("site");
    if (siteName) {
      const site = data.sites.find((s) => s.name === siteName);
      if (site) return renderDetail(site);
    }
    renderOverview();
  }

  route();
})();
