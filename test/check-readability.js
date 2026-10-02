// test/check-readability.js — unit tests for readability-core.mjs.
// Pins the two formulas to hand-computed values, and pins the text-preparation
// rules that decide what gets scored (where most readability tools disagree):
// block boundaries end sentences, collapsed accordions are included, style
// text and accordion glyphs are not, fragments and non-English aren't scored.

import puppeteer from "puppeteer";
import {
  extractBlocks, splitSentences, scoreSentences, scoreArticle, looksEnglish, isFragment, detailJs,
} from "../readability-core.mjs";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

// (a) Formulas, hand-computed. 11 words, 2 sentences, 11 syllables, 30 letters:
//   FK  = 0.39·5.5 + 11.8·1 − 15.59        = −1.645 → −1.6
//   ARI = 4.71·30/11 + 0.5·5.5 − 21.43     = −5.835 → −5.8
{
  const s = scoreSentences(splitSentences("The cat sat on the mat. It was a good day."));
  check("formula: word count", s.words === 11);
  check("formula: sentence count", s.sentences === 2);
  check("formula: syllable count", s.syllables === 11);
  check("formula: FK grade", s.fk_grade === -1.6);
  check("formula: ARI", s.ari === -5.8);
}

// (b) Sentence splitting: abbreviations and times don't end a sentence.
{
  const s = splitSentences("Call Dr. Smith at 9 a.m. Monday. Visit 1 Centre St. in Manhattan. Done!");
  check("split: abbreviations kept inside sentences", s.length === 3);
  check("split: numerals count as words", scoreSentences(["Call 311 now."]).words === 3);
}

// (c) Fragments vs sentences.
check("fragment: short unpunctuated label", isFragment("Proof of identity"));
check("fragment: punctuated sentence is not", !isFragment("Bring proof of identity."));
check("fragment: long unpunctuated block is not", !isFragment(
  "Apply for child care for toddlers 13 months to 3 years old for free or a small fee and more"));

// (d) English guard.
check("lang: English prose", looksEnglish("You can report a problem with the bus stop if it is broken."));
check("lang: Korean", !looksEnglish("NYC311은 한국어를 포함하여 최대한 많은 언어로 서비스를 제공하기 위해 노력합니다."));
check("lang: short English emergency text", looksEnglish("Call 911 to report assault."));
check("lang: Spanish", !looksEnglish("Puede comunicarse con NYC311 en español para obtener información sobre los servicios de la Ciudad."));

// (e) Extraction, in a real browser against markup shaped like the 311 portal.
const FIXTURE = `
<style>.collapse:not(.show) { display: none; }</style>
<div id="knowledgearticle"><div class="ka-content">
  <style>.divTable { display: table; width: 100%; }</style>
  <div class="card"><div class="collapse show">
    <p>Visible paragraph one is here. It has two sentences.</p>
    <ul><li>First list item without a period</li><li>Second list item without a period</li></ul>
  </div></div>
  <div class="card">
    <div class="card-header"><button type="button" data-toggle="collapse">Collapsed Heading</button></div>
    <div class="collapse"><p>This sentence is hidden in a collapsed panel.</p></div>
  </div>
  <details class="faq"><summary>FAQ question <span class="faq-accordion-sign">+</span></summary>
    <div class="faq-accordion-content">Details body sentence is here.</div></details>
  <div style="display:flex"><a href="#" style="display:flex"><span>Card title</span> <span>Card body text sits here.</span> <span style="position:absolute">›</span></a></div>
  <h5><a class="contentaction" href="#">Report a problem now.</a></h5>
  <div style="display:none" class="mystery">Unknown hidden text.</div>
</div></div>
<div class="ka-feedback">Was this information helpful?</div>`;

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setContent(FIXTURE);
const { blocks, unknownHidden } = await page.evaluate(extractBlocks, "#knowledgearticle .ka-content");
await browser.close();

const texts = blocks.map((b) => b.t);
const find = (t) => blocks.find((b) => b.t === t);
check("extract: style text excluded", !texts.some((t) => t.includes("divTable")));
check("extract: accordion glyph excluded", !texts.some((t) => t.includes("+")) && !texts.includes("›"));
check("extract: chrome outside the body excluded", !texts.some((t) => t.includes("helpful")));
check("extract: list items are separate blocks", find("First list item without a period") && find("Second list item without a period"));
check("extract: collapsed panel included and marked", find("This sentence is hidden in a collapsed panel.")?.c === 1);
check("extract: closed <details> body included and marked", find("Details body sentence is here.")?.c === 1);
check("extract: visible text not marked collapsed", find("Visible paragraph one is here. It has two sentences.")?.c === 0);
check("extract: card header (an accordion toggle button) is a heading", find("Collapsed Heading")?.k === "h");
check("extract: flex-laid-out spans split", find("Card title") && find("Card body text sits here."));
check("extract: action button tagged", find("Report a problem now.")?.k === "a");
check("extract: unknown hidden element reported", unknownHidden.length === 1 && unknownHidden[0].cls === "mystery");

const scored = scoreArticle(blocks);
const scoredText = scored.blocks.filter((b) => b.k === "p").map((b) => b.t);
check("score: list fragments not scored", !scoredText.includes("First list item without a period"));
check("score: card title not scored", !scoredText.includes("Card title"));
check("score: action not scored", !scoredText.includes("Report a problem now."));
check("score: collapsed prose scored", scoredText.includes("This sentence is hidden in a collapsed panel."));

// (f) Detail files are deterministic: the same article content gives a
// byte-identical file whatever order its fields arrived in, so an unchanged
// article never shows up as a git change.
{
  const one = { status: "scored", longest: [{ text: "A b c.", words: 3 }], blocks: [{ k: "p", c: 0, t: "A b c.", s: ["A b c."] }], unknown_hidden: [], scores: { ari: 1 } };
  const two = { unknown_hidden: [], blocks: [{ s: ["A b c."], t: "A b c.", c: false, k: "p" }], scores: { ari: 1 }, longest: [{ words: 3, text: "A b c." }], status: "scored" };
  check("detail: byte-identical across field order", detailJs("KA-00001", one) === detailJs("KA-00001", two));
  check("detail: no timestamps or scores", !/checked_at|\d{4}-\d{2}-\d{2}T|"ari"/.test(detailJs("KA-00001", one)));
}

if (failures.length) {
  console.error(`check-readability: ${failures.length} failure(s):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("check-readability: all readability checks passed.");
