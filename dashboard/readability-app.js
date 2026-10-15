// readability-app.js — render READABILITY_DATA into an overview or per-article view.
//
// Sibling of app.js and links-app.js, deliberately kept separate: this is a
// reading-grade estimate for NYC311 help articles, NOT the accessibility scan.
//
// No good/bad bands on purpose: the page reports what the formulas measure
// without judging it. Both scores are shown as-is, on a continuous single-hue
// scale (deeper = higher grade) with no cutoffs, targets, or red/green valence.
//
// View routing: `?ka=<KA number>` shows one article's details; otherwise the
// overview. No router, no framework — plain DOM building, reusing styles.css.

(function () {
  "use strict";

  const data = window.READABILITY_DATA;
  const app = document.getElementById("app");
  const footerMeta = document.getElementById("footer-meta");

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }

  const fmtNum = (n) => n.toLocaleString("en-US");
  const fmtGrade = (n) => n.toFixed(1);

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch { return iso; }
  }

  if (!data || !Array.isArray(data.articles)) {
    app.innerHTML = `<div class="error-banner">
      <p class="error-banner-label">No readability data</p>
      <p class="error-banner-body">Run <code>node check-readability.mjs</code>, and reload.</p>
    </div>`;
    return;
  }

  // Continuous shading: the grade maps linearly onto the tint's strength over a
  // fixed span (not this dataset's min–max, which would exaggerate small gaps
  // and shift between runs). Grades outside the span just take the end shade.
  const SHADE_FROM = 4;
  const SHADE_TO = 16;
  // One hue (blue), varying only lightness from pale to deep, so every step
  // reads as the same color getting stronger. Text flips to white wherever
  // that has the better contrast, so every shade stays legible.
  const HUE = 214, SAT = 0.62, L_LIGHT = 0.95, L_DARK = 0.2;
  function hslToRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const INK_L = luminance([20, 23, 26]); // --ink
  function shadeStyle(grade) {
    const t = Math.min(1, Math.max(0, (grade - SHADE_FROM) / (SHADE_TO - SHADE_FROM)));
    const rgb = hslToRgb(HUE, SAT, L_LIGHT + (L_DARK - L_LIGHT) * t);
    const L = luminance(rgb);
    const text = 1.05 / (L + 0.05) > (L + 0.05) / (INK_L + 0.05) ? "#ffffff" : "#14171a";
    return `background: rgb(${rgb.join(", ")}); color: ${text};`;
  }
  const gradeChip = (grade) => el("span", { class: "rd-grade", style: shadeStyle(grade) }, fmtGrade(grade));

  function setFooter() {
    if (!footerMeta) return;
    const excluded = data.excluded_non_english
      ? ` · ${fmtNum(data.excluded_non_english)} non-English articles not included`
      : "";
    footerMeta.textContent =
      `${fmtNum(data.articles.length)} articles${excluded}` + (data.checked_at ? ` · checked ${fmtDate(data.checked_at)}` : "");
  }

  // ---- overview -------------------------------------------------------------

  function intro() {
    return el("div", { class: "rd-intro" },
      el("p", {},
        el("strong", {}, "ARI"), " (Automated Readability Index, the formula behind Hemingway Editor's grade) and ",
        el("strong", {}, "Flesch-Kincaid"), " are two published formulas. " +
        "Each estimates a U.S. school grade level from sentence length and word length. " +
        "Neither measures jargon, layout, or whether readers can complete their task."
      ),
      scaleKey()
    );
  }

  function scaleKey() {
    const stops = [];
    for (let g = SHADE_FROM; g <= SHADE_TO; g += 2) stops.push(g);
    return el("div", { class: "rd-scale", "aria-hidden": "true" },
      el("span", { class: "rd-scale-label" }, "Lower grade"),
      el("span", { class: "rd-scale-bar" }, stops.map((g) => el("span", { style: shadeStyle(g) }, String(g)))),
      el("span", { class: "rd-scale-label" }, "Higher grade")
    );
  }

  const COLUMNS = [
    { key: "title", label: "Article", get: (a) => a.title.toLowerCase(), numeric: false },
    { key: "ari", label: "ARI", get: (a) => a.scores?.ari, numeric: true },
    { key: "fk", label: "Flesch-Kincaid", get: (a) => a.scores?.fk_grade, numeric: true },
    { key: "words", label: "Words", get: (a) => a.scores?.words, numeric: true },
    { key: "avg", label: "Words per sentence", get: (a) => a.scores?.avg_sentence_words, numeric: true },
  ];
  // ARI leads because it's the score checked against an outside tool: it
  // matches Hemingway Editor's grade, a widely used readability checker.
  let sort = { key: "ari", dir: -1 };
  let query = "";

  function matches(a) {
    if (!query) return true;
    return a.title.toLowerCase().includes(query) || a.ka.toLowerCase().includes(query);
  }

  function sortArticles(list) {
    const col = COLUMNS.find((c) => c.key === sort.key);
    return [...list].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      // Unscored articles always sink to the bottom, whatever the direction.
      if (va == null && vb == null) return a.title.localeCompare(b.title);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }

  function headerCell(col) {
    const active = sort.key === col.key;
    const arrow = active ? (sort.dir === 1 ? " ▲" : " ▼") : "";
    return el("th", {
      class: col.numeric ? "numeric" : null,
      "aria-sort": active ? (sort.dir === 1 ? "ascending" : "descending") : null,
    },
      el("button", {
        type: "button",
        class: "rd-sort",
        onclick: () => {
          sort = active ? { key: col.key, dir: -sort.dir } : { key: col.key, dir: col.numeric ? -1 : 1 };
          renderTable();
        },
      }, col.label + arrow)
    );
  }

  // The search box is built once; typing and sorting only rebuild the table,
  // so the box keeps focus and what's been typed.
  let tableHost, countEl;

  function searchBox() {
    countEl = el("span", { class: "rd-count", "aria-live": "polite" });
    return el("div", { class: "rd-search" },
      el("label", { for: "rd-q" }, "Search articles"),
      el("input", {
        id: "rd-q",
        type: "search",
        placeholder: "Title or KA number",
        autocomplete: "off",
        oninput: (e) => {
          query = e.target.value.trim().toLowerCase();
          renderTable();
        },
      }),
      countEl,
      el("button", { type: "button", class: "rd-download", onclick: downloadCsv }, "Download all results (CSV)")
    );
  }

  // ---- export ---------------------------------------------------------------

  // Every article (whatever the search box holds), in the table's current
  // sort order. The KA number is the key for joining this to other article
  // lists; the URL lets a spreadsheet link straight to the article.
  const CSV_COLUMNS = [
    ["KA number", (a) => a.ka],
    ["Title", (a) => a.title],
    ["URL", (a) => a.url],
    ["ARI", (a) => a.scores?.ari],
    ["Flesch-Kincaid", (a) => a.scores?.fk_grade],
    ["Words", (a) => a.scores?.words],
    ["Sentences", (a) => a.scores?.sentences],
    ["Words per sentence", (a) => a.scores?.avg_sentence_words],
    [`Sentences over ${data.long_sentence_words ?? 25} words`, (a) => a.scores?.long_sentences],
    ["% of words in collapsed sections", (a) => a.scores?.collapsed_pct],
    ["Status", (a) => (a.status === "scored" ? "Scored" : a.reason || a.status)],
  ];

  function csvCell(v) {
    if (v == null) return "";
    let s = String(v);
    // Text starting with = + - @ would be run as a formula by spreadsheet apps.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadCsv() {
    const rows = [CSV_COLUMNS.map(([h]) => h), ...sortArticles(data.articles).map((a) => CSV_COLUMNS.map(([, get]) => get(a)))];
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    // The byte-order mark tells Excel the file is UTF-8 (titles have curly quotes and accents).
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const date = (data.checked_at || "").slice(0, 10);
    const link = el("a", { href: url, download: `nyc311-readability${date ? "-" + date : ""}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderOverview() {
    app.replaceChildren();
    tableHost = el("div");
    app.append(intro(), searchBox(), tableHost);
    renderTable();
    setFooter();
  }

  function renderTable() {
    const list = sortArticles(data.articles.filter(matches));
    countEl.textContent = `Showing ${fmtNum(list.length)} of ${fmtNum(data.articles.length)} articles`;

    const rows = list.map((a) => {
      const s = a.scores;
      const dash = () => el("span", { class: "rd-dash" }, "—");
      return el("tr", {},
        el("td", {},
          el("a", { class: "rd-title", href: a.url }, a.title),
          el("div", { class: "rd-sub" },
            a.ka, " · ",
            el("a", { href: `?ka=${encodeURIComponent(a.ka)}`, "aria-label": `Details for ${a.title}` }, "Details")
          )
        ),
        el("td", { class: "numeric" }, s ? gradeChip(s.ari) : el("span", { class: "rd-unscored" }, a.status === "error" ? "Couldn't load" : "Not scored")),
        el("td", { class: "numeric" }, s ? gradeChip(s.fk_grade) : dash()),
        el("td", { class: "numeric" }, s ? fmtNum(s.words) : dash()),
        el("td", { class: "numeric" }, s ? fmtGrade(s.avg_sentence_words) : dash())
      );
    });

    tableHost.replaceChildren(
      el("div", { class: "sites-table-wrap rd-table-wrap" },
        el("table", { class: "sites-table rd-table" },
          el("thead", {}, el("tr", {}, COLUMNS.map(headerCell))),
          el("tbody", {}, rows)
        )
      )
    );
  }

  // ---- per-article details --------------------------------------------------

  function statCell(value, label) {
    return el("div", {},
      el("div", { class: "detail-header-stat-num" }, value),
      el("div", { class: "detail-header-stat-lbl" }, label)
    );
  }

  function block(b) {
    const collapsed = b.c ? " rd-collapsed" : "";
    if (b.k === "h") return el("div", { class: "rd-block rd-label" + collapsed }, b.t);
    if (b.k === "a") {
      return el("div", { class: "rd-block rd-action" + collapsed },
        el("span", { class: "rd-tag" }, "button"), " ", b.t);
    }
    return el("p", { class: "rd-block rd-prose" + collapsed }, b.t);
  }

  function legend() {
    return el("div", { class: "rd-legend" },
      el("span", {}, el("span", { class: "rd-legend-collapsed" }), "Hidden until the reader expands it")
    );
  }

  function section(title, ...content) {
    return el("section", { class: "rd-section" },
      el("div", { class: "section-eyebrow" }, el("span", { class: "section-eyebrow-title" }, title)),
      ...content
    );
  }

  // Each article's extracted text lives in its own file, readability/<KA>.js,
  // loaded by <script> tag (like the rest of the dashboard, so it works from
  // file:// too). The overview data only carries the scores.
  function loadDetail(a) {
    app.replaceChildren(el("p", { class: "loading", "aria-busy": "true" }, "Loading article details…"));
    const tag = document.createElement("script");
    tag.src = `readability/${a.ka}.js`;
    tag.onload = () => renderDetail({ ...a, ...window.READABILITY_DETAIL });
    tag.onerror = () => renderDetail(a);
    document.head.appendChild(tag);
  }

  function renderDetail(a) {
    app.replaceChildren();
    const s = a.scores;
    app.append(
      el("div", {}, el("a", { class: "detail-back", href: "readability.html" }, "← All articles")),
      el("div", { class: "detail-header" },
        el("div", {},
          el("h2", { class: "detail-header-title rd-detail-title" }, el("a", { href: a.url }, a.title)),
          el("div", { class: "detail-header-url" }, a.ka)
        ),
        s
          ? el("div", { class: "detail-header-stats rd-stats" },
              statCell(gradeChip(s.ari), "ARI"),
              statCell(gradeChip(s.fk_grade), "Flesch-Kincaid"),
              statCell(fmtNum(s.words), "Words"),
              statCell(fmtGrade(s.avg_sentence_words), "Words per sentence"))
          : null
      )
    );

    if (a.status !== "scored") {
      app.append(el("p", { class: "rd-note rd-warn" }, a.reason || "Not scored."));
    } else {
      app.append(el("p", { class: "rd-note" },
        "Both scores estimate a U.S. school grade level. ARI is the formula behind Hemingway Editor's grade. " +
        "All of the article's text is scored, and each heading, list item, and button counts as its own sentence. " +
        (a.low_confidence ? `With only ${fmtNum(s.words)} words, either grade is a rough estimate. ` : "") +
        `${s.collapsed_pct}% of the scored words are in sections hidden until the reader expands them.`
      ));

      if (a.longest?.length) {
        app.append(section("Longest sentences",
          el("ol", { class: "rd-longest" },
            a.longest.map((l) => el("li", {}, el("span", { class: "rd-longest-n" }, `${l.words} words`), l.text)))
        ));
      }
    }

    if (a.blocks?.length) {
      app.append(section("Text that was scored", legend(),
        el("div", { class: "rd-text", lang: a.status === "scored" ? "en" : null }, a.blocks.map(block))));
    } else if (a.status !== "error") {
      app.append(el("p", { class: "rd-note" }, "The extracted text for this article isn't available."));
    }
    if (a.unknown_hidden?.length) {
      app.append(el("p", { class: "rd-note rd-warn" },
        `${a.unknown_hidden.length} hidden element(s) on this page matched no known accordion pattern. ` +
        "Their text is included above; check whether it is real content."));
    }
    setFooter();
  }

  // The refresh date goes in the masthead, so it's in view on every page.
  function setUpdated() {
    const meta = document.getElementById("masthead-meta");
    if (!meta || !data.checked_at) return;
    meta.append(el("div", {}, el("dt", {}, "Last updated"), el("dd", {}, fmtDate(data.checked_at))));
  }

  // ---- route ----------------------------------------------------------------

  function route() {
    const ka = new URLSearchParams(location.search).get("ka");
    if (ka && /^KA-\d+$/.test(ka)) {
      const a = data.articles.find((x) => x.ka === ka);
      if (a) return loadDetail(a);
    }
    renderOverview();
  }

  setUpdated();
  route();
})();
