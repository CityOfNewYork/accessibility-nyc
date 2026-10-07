// readability-core.mjs — text extraction and scoring rules for the NYC311
// readability preview (check-readability.mjs → dashboard/readability.html).
//
// Readability is a site-quality signal, NOT a WCAG result: nothing here feeds
// the accessibility tiers, counts, or history. Kept apart from scan-core.mjs
// for that reason, and so the rules can be unit-tested without a browser.
//
// Formulas are deliberately few and public:
//   Flesch-Kincaid Grade = 0.39·(words/sentences) + 11.8·(syllables/words) − 15.59
//   ARI (what Hemingway's grade uses) = 4.71·(chars/words) + 0.5·(words/sentences) − 21.43
// Online calculators disagree by many grade levels on the same raw text; most
// of that is text preparation (Mac et al. 2022, PMC9856555). So the preparation
// rules are the part to scrutinise — they live in extractBlocks() and
// splitSentences() and are pinned by test/check-readability.js.

import { syllable } from "syllable";

// Sentences longer than this are counted in long_sentences / long_pct.
export const LONG_SENTENCE_WORDS = 25;
// Below this many words a grade is too noisy to sort on; still shown, but flagged.
export const MIN_RELIABLE_WORDS = 100;

// Runs INSIDE the page (passed to page.evaluate), so it must be self-contained.
// Walks the article body and returns blocks of text, one per block-level
// element, so a bulleted list or table never merges into one giant "sentence".
// Uses textContent, not innerText: collapsed accordion sections are real
// content a reader can expand, and innerText would silently drop them.
//   k: "p" prose · "h" heading/label · "a" action button (all are scored;
//      scoreArticle() also demotes short unpunctuated prose fragments to "h")
//   c: 1 if the text sits in a section that is collapsed by default
// Returns { blocks, unknownHidden }, where unknownHidden lists hidden elements
// that are neither a collapsed accordion nor known noise — new patterns to review.
export function extractBlocks(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return null;

  const SKIP = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "SVG", "IMG", "IFRAME", "INPUT", "SELECT", "TEXTAREA"]);
  const SKIP_CLASS = ["faq-accordion-sign"]; // the +/− glyph on FAQ accordions
  const HEADING = "h1, h2, h3, h4, h5, h6, .card-header, summary, .divTableCell1, .faq-accordion-label";
  // Service-request links win over everything; a bare <button> only counts as
  // an action outside a heading, because accordion headers are toggle buttons.
  const ACTION = ".contentaction";

  const hidden = (e) => {
    const s = getComputedStyle(e);
    return s.display === "none" || s.visibility === "hidden";
  };
  // An accordion panel a reader can open: Bootstrap .collapse, or the body of a closed <details>.
  const isAccordion = (e) => e.classList.contains("collapse") || !!e.closest("details:not([open])");

  const blocks = [];
  const unknownHidden = [];
  let buf = [];

  const flush = () => {
    const text = buf.map((b) => b.text).join("").replace(/[\s ]+/g, " ").trim();
    if (/[\p{L}\p{N}]/u.test(text)) {
      const kinds = new Set(buf.filter((b) => b.text.trim()).map((b) => b.k));
      const k = kinds.has("a") ? "a" : kinds.size === 1 && kinds.has("h") ? "h" : "p";
      const c = buf.some((b) => b.text.trim() && b.c) ? 1 : 0;
      blocks.push({ k, c, t: text });
    }
    buf = [];
  };

  const walk = (node, collapsed) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      const k = parent.closest(ACTION) ? "a" : parent.closest(HEADING) ? "h" : parent.closest("button") ? "a" : "p";
      buf.push({ text: node.textContent, k, c: collapsed });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP.has(node.tagName) || SKIP_CLASS.some((c) => node.classList.contains(c))) return;

    let c = collapsed;
    // The body of a closed <details> is collapsed whatever its computed style
    // reports (browsers hide it via the details-content slot, not display).
    if (!collapsed && node.parentElement?.tagName === "DETAILS" && !node.parentElement.open && node.tagName !== "SUMMARY") {
      c = true;
    } else if (!collapsed && node !== root && hidden(node)) {
      c = true;
      if (!isAccordion(node) && node.textContent.trim()) {
        unknownHidden.push({
          tag: node.tagName,
          id: node.id || null,
          cls: String(node.className || "").slice(0, 80) || null,
          text: node.textContent.replace(/\s+/g, " ").trim().slice(0, 120),
        });
      }
    }

    // Block boundaries follow the computed layout, not the tag: 311 builds link
    // cards out of <a>/<span> laid out as blocks (flex items), and those must
    // not run together. Computed display holds even inside collapsed panels.
    const block = !/^(inline|contents)$/.test(getComputedStyle(node).display);
    if (block || node.tagName === "BR") flush();
    for (const child of node.childNodes) walk(child, c);
    if (block) flush();
  };

  walk(root, false);
  flush();
  return { blocks, unknownHidden };
}

// Abbreviations whose trailing period does not end a sentence.
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "st", "ave", "blvd", "rd", "no", "nos", "inc", "corp", "dept",
  "jr", "sr", "vs", "etc", "e.g", "i.e", "a.m", "p.m", "u.s", "n.y", "n.y.c", "approx", "apt", "ft",
]);

// Split one block into sentences. A block boundary always ends a sentence;
// inside a block, split after . ! ? when followed by space + a capital/digit/quote.
export function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /[.!?]+["'”’)]*\s+(?=["'“(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(start, m.index);
    const lastWord = (before.match(/(\S+)$/)?.[1] || "").toLowerCase().replace(/^[("'“]+/, "");
    if (m[0].startsWith(".") && ABBREV.has(lastWord)) continue;
    out.push(text.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter((s) => words(s).length > 0);
}

// URLs and email addresses aren't words a reader parses syllable by syllable;
// left in, one long URL swings ARI by a grade.
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b\S+@\S+\.\S+/gi;

// Words: runs of letters/digits, keeping internal apostrophes, hyphens, and
// number punctuation together ("pedal-assist", "don't", "$1,500", "10:00").
export function words(text) {
  return text.replace(URLISH, " ").match(/[A-Za-z0-9À-ɏ]+(?:['’\-.,:/][A-Za-z0-9À-ɏ]+)*/g) || [];
}

// syllable() returns 0 for numerals; a number is read aloud as at least one.
export function syllables(word) {
  return Math.max(1, syllable(word));
}

const letters = (w) => (w.match(/[A-Za-z0-9À-ɏ]/g) || []).length;

// English guard. The formulas are calibrated on English; the index also lists
// translated articles, which must not get a grade. Language is detected from
// the text itself.
// Two signals: mostly non-Latin script (Korean, Arabic, Chinese, …), or
// Latin-script text with almost no common English function words (Spanish, French, …).
// Run it on prose, not labels: address lists and contact cards have few
// function words. Measured on the full index, prose ratios: translations ≤ 0.03,
// lowest English article 0.094 — the 0.05 threshold sits in that gap.
const EN_FUNCTION = new Set(
  "the and to of a in is you for your or on can be with are if this that it by at from as not have will an".split(" ")
);
export function looksEnglish(text) {
  const allLetters = (text.match(/\p{L}/gu) || []).length;
  if (!allLetters) return false;
  const latin = (text.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  if (latin / allLetters < 0.5) return false;
  const ws = words(text).map((w) => w.toLowerCase());
  if (!ws.length) return false;
  return ws.filter((w) => EN_FUNCTION.has(w)).length / ws.length >= 0.05;
}

const round1 = (n) => Math.round(n * 10) / 10;

// Score a list of sentences (strings). Returns null when there are no words.
export function scoreSentences(sentences) {
  let w = 0, syl = 0, chars = 0, long = 0;
  for (const s of sentences) {
    const ws = words(s);
    w += ws.length;
    if (ws.length > LONG_SENTENCE_WORDS) long++;
    for (const x of ws) {
      syl += syllables(x);
      chars += letters(x);
    }
  }
  const n = sentences.length;
  if (!w || !n) return null;
  return {
    fk_grade: round1(0.39 * (w / n) + 11.8 * (syl / w) - 15.59),
    ari: round1(4.71 * (chars / w) + 0.5 * (w / n) - 21.43),
    words: w,
    sentences: n,
    syllables: syl,
    avg_sentence_words: round1(w / n),
    long_sentences: long,
    long_pct: Math.round((100 * long) / n),
  };
}

// A short block with no sentence punctuation is a label rather than prose: a
// link-card title, a table header, a list item like "Proof of identity".
// Labels are scored like everything else, but kept out of the language guard.
export const FRAGMENT_MAX_WORDS = 10;
export function isFragment(text) {
  return !/[.!?:;]["'”’)]*$/.test(text.trim()) && words(text).length < FRAGMENT_MAX_WORDS;
}

// Score an article from extractBlocks() output. Every block is scored: headings,
// labels, list items and action buttons are text the reader reads, and since a
// block boundary ends a sentence, each one counts as (at least) its own sentence.
// The prose/label split (k) still matters for the language guard and the
// extracted-text view.
export function scoreArticle(blocks) {
  const out = blocks
    .map((b) => (b.k === "p" && isFragment(b.t) ? { ...b, k: "h" } : b))
    .map((b) => ({ ...b, s: splitSentences(b.t) }));
  const prose = out.filter((b) => b.k === "p");
  // Language is judged on prose; an article with no prose falls back to all its text.
  const langText = prose.length ? prose.map((b) => b.t).join(" ") : out.map((b) => b.t).join(" ");

  if (!looksEnglish(langText)) {
    return { status: "not-scored", reason_code: "non-english", reason: "Not English — these formulas only apply to English text.", blocks: out };
  }
  const sentences = out.flatMap((b) => b.s);
  const scores = scoreSentences(sentences);
  if (!scores) {
    return { status: "not-scored", reason_code: "no-prose", reason: "No text found in the article body.", blocks: out };
  }
  const collapsedWords = out.filter((b) => b.c).reduce((n, b) => n + words(b.t).length, 0);
  scores.collapsed_words = collapsedWords;
  scores.collapsed_pct = Math.round((100 * collapsedWords) / scores.words);

  const longest = sentences
    .map((s) => ({ text: s, words: words(s).length }))
    .sort((a, b) => b.words - a.words)
    .slice(0, 5);

  return {
    status: "scored",
    low_confidence: scores.words < MIN_RELIABLE_WORDS,
    scores,
    longest,
    blocks: out,
  };
}

// The per-article detail file the dashboard loads by <script> tag. Built field
// by field in a fixed order, with no timestamps, so an unchanged article
// rewrites a byte-identical file and git records nothing new.
export function detailJs(ka, article) {
  const block = (b) => {
    const o = { k: b.k, c: b.c ? 1 : 0, t: b.t };
    if (b.s) o.s = b.s;
    return o;
  };
  const detail = {
    ka,
    longest: (article.longest || []).map((l) => ({ text: l.text, words: l.words })),
    blocks: (article.blocks || []).map(block),
    unknown_hidden: (article.unknown_hidden || []).map((h) => ({ tag: h.tag, id: h.id ?? null, cls: h.cls ?? null, text: h.text })),
  };
  return `window.READABILITY_DETAIL = ${JSON.stringify(detail)};\n`;
}
