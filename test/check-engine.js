// test/check-engine.js — sanity test for the scanner.
// Runs axe-core against a deliberately-broken fixture and asserts that the
// engine catches the obvious issues. If this ever passes a clean bill of
// health on broken.html, something is wrong with how we wired up axe.

import puppeteer from "puppeteer";
import { AxePuppeteer } from "@axe-core/puppeteer";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "../test-fixtures/broken.html");

// Rules we expect axe to fire on, given the bugs in broken.html.
// (Names are stable axe rule IDs, not names that change between versions.)
// Note: WCAG 2.2 removed SC 4.1.1 Parsing, so duplicate-id is no longer
// included in axe's WCAG-tagged rule set. We don't assert it here.
const EXPECTED_RULES = [
  "image-alt",            // <img> without alt
  "button-name",          // <button> with no text
  "link-name",            // <a> with no text
  "label",                // <input> with no label
  "color-contrast",       // light grey on white
  "html-has-lang",        // <html> missing lang attribute
];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.goto(fixture, { waitUntil: "load" });

const result = await new AxePuppeteer(page)
  .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
  .analyze();
await browser.close();

const found = new Set(result.violations.map((v) => v.id));
const missing = EXPECTED_RULES.filter((r) => !found.has(r));

console.log(`Fixture: ${fixture}`);
console.log(`Found ${result.violations.length} violation rules: ${[...found].join(", ")}`);

if (missing.length > 0) {
  console.error(`\n✗ FAIL — engine did not catch expected rules: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`\n✓ PASS — engine caught all ${EXPECTED_RULES.length} expected violation types.`);
