// test/check-readability.js — unit tests for readability-core.mjs.
// Pins the two formulas to hand-computed values, and pins the text-preparation
// rules that decide what gets scored (where most readability tools disagree):
// block boundaries end sentences, collapsed accordions are included, style
// text and accordion glyphs are not, headings and list items are scored as
// their own sentences, and non-English isn't scored.

import { readFileSync } from "node:fs";
import puppeteer from "puppeteer";
import {
  extractBlocks, splitSentences, scoreSentences, scoreArticle, looksEnglish, isFragment, detailJs,
  PHONE, agencyTerms, agencyNameMatcher, withoutExcluded,
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

// Every block is scored, and each heading, label, list item and button ends a
// sentence, so the sentence count is the prose sentences plus one per fragment.
const scored = scoreArticle(blocks);
const scoredText = scored.blocks.map((b) => b.t);
const allSentences = scored.blocks.flatMap((b) => b.s);
check("score: list items scored, one sentence each",
  allSentences.includes("First list item without a period") && allSentences.includes("Second list item without a period"));
check("score: heading scored", allSentences.includes("Collapsed Heading"));
check("score: card title scored", allSentences.includes("Card title"));
check("score: action scored", allSentences.includes("Report a problem now."));
check("score: collapsed prose scored", scoredText.includes("This sentence is hidden in a collapsed panel."));
check("score: sentence count covers every block", scored.scores.sentences === allSentences.length && allSentences.length === 12);
check("score: labels still marked for the text view", scored.blocks.find((b) => b.t === "Card title")?.k === "h");

// (f) Detail files are deterministic: the same article content gives a
// byte-identical file whatever order its fields arrived in, so an unchanged
// article never shows up as a git change.
{
  const one = { status: "scored", longest: [{ text: "A b c.", words: 3 }], blocks: [{ k: "p", c: 0, t: "A b c.", s: ["A b c."] }], unknown_hidden: [], scores: { ari: 1 } };
  const two = { unknown_hidden: [], blocks: [{ s: ["A b c."], t: "A b c.", c: false, k: "p" }], scores: { ari: 1 }, longest: [{ words: 3, text: "A b c." }], status: "scored" };
  check("detail: byte-identical across field order", detailJs("KA-00001", one) === detailJs("KA-00001", two));
  check("detail: no timestamps or scores", !/checked_at|\d{4}-\d{2}-\d{2}T|"ari"/.test(detailJs("KA-00001", one)));
}

// (g) The second ARI: phone numbers and official agency names left out.
{
  const phones = (t) => t.match(PHONE) || [];
  check("phone: digits, parentheses, vanity letters", phones(
    "Call 212-NEW-YORK (212-639-9675), (718) 557-1399, (800) 577-TIPS, 1-877-RED-CROSS, or 212-POISONS."
  ).length === 6);
  check("phone: ZIP+4, room numbers and short codes stay", phones("New York, NY 10038-4648, Room 311. Call 911 or 988.").length === 0);

  const orgs = [
    { name: "Department of Consumer and Worker Protection", acronym: "DCWP", alternate_or_former_names: "Department of Consumer Affairs", alternate_or_former_acronyms: "DCA" },
    { name: "Department of Health and Mental Hygiene", acronym: "DOHMH", alternate_or_former_names: "NYC Health;Health Department", alternate_or_former_acronyms: "DOH" },
    { name: "Mayor's Office to Protect Tenants", acronym: "MOPT", alternate_or_former_names: null, alternate_or_former_acronyms: null },
    { name: "New York City Law Department", acronym: "LAW", alternate_or_former_names: null, alternate_or_former_acronyms: "Law;Law Dept." },
  ];
  const terms = agencyTerms(orgs);
  check("agency: alternates split on semicolons", terms.includes("NYC Health") && terms.includes("Health Department"));
  check("agency: entries that mean something else in articles are skipped", !terms.includes("Law") && !terms.includes("DOH"));
  const re = agencyNameMatcher(terms);
  const cut = (s) => withoutExcluded(s, re);

  const a = cut("Contact the Department of Consumer and Worker Protection (DCWP) or DCWP’s office.");
  check("agency: name and acronym out, empty parentheses with them", a.text === "Contact the or office.");
  check("agency: possessive taken with the name", a.removed.includes("DCWP’s"));
  check("agency: overlapping list names merge", cut("The NYC Health Department inspects restaurants.").text === "The inspects restaurants.");
  check("agency: ’ matches '", cut("The Mayor’s Office to Protect Tenants held hearings.").text === "The held hearings.");
  check("agency: case-sensitive, whole words only", cut("Local Law 18 changed how departments of health work.").removed.length === 0);
}

// The hand-kept list: every agency says which level it is, its official name
// and where that comes from, and its other forms; every form goes, whole,
// ahead of any official-list name inside it.
{
  const { agencies } = JSON.parse(readFileSync(new URL("../readability-agency-names-extra.json", import.meta.url), "utf8"));
  check("extra names: every agency has a level, official name, source, and other forms",
    agencies.length > 0 && agencies.every((a) => ["City", "State", "Federal"].includes(a.level) && a.name && /^https:\/\//.test(a.source) && Array.isArray(a.also_written)));
  const re = agencyNameMatcher([...agencies.flatMap((a) => [a.name, a.acronym, ...a.also_written]).filter(Boolean), "Department of Labor"]);
  const r = withoutExcluded("Find the NY State Department of Labor's list, or ask the Federal Emergency Management Agency (FEMA), the EPA, or the NYC Commission on Human Rights.", re);
  check("extra names: every form cut whole, possessive included",
    r.text === "Find the list, or ask the , the , or the ." && r.removed.includes("NY State Department of Labor's"));
}

// Scoring: the second ARI drops what was cut, and a sentence that was only a
// name drops out of the count; with nothing to cut, both ARIs agree.
{
  const re = agencyNameMatcher(["Department of Finance"]);
  const blocks = [
    { k: "h", c: 0, t: "Department of Finance" },
    { k: "p", c: 0, t: "Pay your bill to the Department of Finance by mail. Call (212) 639-9675 for help." },
  ];
  const r = scoreArticle(blocks, { nameRe: re });
  check("score: second ARI matches the cut text",
    r.scores.ari_excl === scoreSentences(["Pay your bill to the by mail.", "Call for help."]).ari);
  check("score: first ARI unchanged by the cut", r.scores.ari === scoreArticle(blocks).scores.ari);
  check("score: what was cut is listed, most frequent first",
    JSON.stringify(r.excluded) === JSON.stringify([{ t: "Department of Finance", n: 2 }, { t: "(212) 639-9675", n: 1 }]));
  const plain = scoreArticle([{ k: "p", c: 0, t: "Bring two proofs of address to the office." }], { nameRe: re });
  check("score: nothing to cut, both ARIs agree", plain.scores.ari_excl === plain.scores.ari && plain.excluded.length === 0);
}

if (failures.length) {
  console.error(`check-readability: ${failures.length} failure(s):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("check-readability: all readability checks passed.");
