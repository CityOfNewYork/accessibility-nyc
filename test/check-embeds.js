// test/check-embeds.js — unit test for the third-party embed exclusion (scan.js).
//
// The contract the dashboard and history depend on: findings INSIDE an excluded
// embed (currently YouTube) are tagged and skipped by every counting path, so
// they can never move a tier — while findings ON the embed (the agency's own
// <iframe> tag, e.g. frame-title) and findings from every other vendor stay
// counted. Getting this backwards would either hide real agency bugs or keep
// scoring vendor markup the agency cannot edit.

import {
  tagEmbedNodes,
  countByImpact,
  countedNodes,
  excludedEmbedFor,
  tierFor,
} from "../scan.js";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const violation = (id, impact, nodes) => ({
  id,
  impact,
  description: `${id} description`,
  help: `${id} help`,
  helpUrl: `https://example.com/${id}`,
  tags: ["wcag2a"],
  nodes,
});

const YT = "https://www.youtube.com/embed/abc123";
const YT_NOCOOKIE = "https://www.youtube-nocookie.com/embed/abc123?start=255";
const TABLEAU = "https://public.tableau.com/views/thing";

// (a) Host matching: both YouTube domains are excluded, other vendors are not.
{
  check("a: youtube.com excluded", excludedEmbedFor(YT)?.vendor === "YouTube");
  check("a: youtube-nocookie.com excluded", excludedEmbedFor(YT_NOCOOKIE)?.vendor === "YouTube");
  check("a: tableau not excluded", excludedEmbedFor(TABLEAU) === null);
  check("a: garbage url not excluded", excludedEmbedFor("not-a-url") === null);
  // Substring matching would be a security-shaped bug: an attacker-controlled
  // host like youtube.com.evil.test must not inherit the exclusion.
  check(
    "a: lookalike host not excluded",
    excludedEmbedFor("https://www.youtube.com.evil.test/embed/x") === null
  );
}

// (b) A finding inside a YouTube frame is tagged; the same rule inside a
// Tableau frame is not.
{
  const violations = [
    violation("button-name", "critical", [
      { target: ["iframe#yt", ".avatar"], html: "<button>" },
      { target: ["iframe#tab", ".viz-btn"], html: "<button>" },
    ]),
  ];
  const frameMap = new Map([
    ["iframe#yt", YT],
    ["iframe#tab", TABLEAU],
  ]);
  tagEmbedNodes(violations, frameMap);
  const [ytNode, tabNode] = violations[0].nodes;
  check("b: youtube node tagged", ytNode.embed?.vendor === "YouTube");
  check("b: tableau node untagged", tabNode.embed === undefined);
  check("b: only the tableau node counts", countedNodes(violations[0]).length === 1);
}

// (c) A finding ON the iframe itself (single-element target, e.g. frame-title)
// is the agency's own markup and stays counted even when it points at YouTube.
{
  const violations = [
    violation("frame-title", "serious", [{ target: ["iframe#yt"], html: "<iframe>" }]),
  ];
  tagEmbedNodes(violations, new Map([["iframe#yt", YT]]));
  check("c: frame-title stays counted", violations[0].nodes[0].embed === undefined);
  check("c: frame-title in counts", countByImpact(violations).serious === 1);
}

// (d) The tier consequence: a page whose ONLY critical sits inside a YouTube
// embed must not be red. This is the whole point of the change.
{
  const violations = [
    violation("aria-allowed-attr", "critical", [
      { target: ["iframe#yt", "a.title"], html: "<a>" },
    ]),
  ];
  tagEmbedNodes(violations, new Map([["iframe#yt", YT]]));
  const counts = countByImpact(violations);
  check("d: no counted criticals", counts.critical === 0);
  check("d: tier is green, not red", tierFor(counts) === "green");
}

// (e) A rule with nodes on both sides keeps the counted ones and is scored on
// those alone — the excluded nodes must not inflate the count.
{
  const violations = [
    violation("color-contrast", "serious", [
      { target: ["iframe#yt", "span"], html: "<span>" },
      { target: ["main", "p"], html: "<p>" },
      { target: ["footer p"], html: "<p>" },
    ]),
  ];
  tagEmbedNodes(violations, new Map([["iframe#yt", YT]]));
  check("e: two nodes counted", countByImpact(violations).serious === 2);
  check("e: three nodes retained", violations[0].nodes.length === 3);
}

// (f) An unresolvable frame selector (the frame moved between the axe run and
// the lookup) stays counted. Over-counting beats silently dropping a finding.
{
  const violations = [
    violation("button-name", "critical", [{ target: ["iframe#gone", ".btn"], html: "<button>" }]),
  ];
  tagEmbedNodes(violations, new Map([["iframe#gone", ""]]));
  check("f: unresolved frame stays counted", countByImpact(violations).critical === 1);
}

// (g) Legacy records from before this change carry no `embed` tags at all and
// must flow through the counting path unchanged.
{
  const violations = [
    violation("image-alt", "critical", [{ target: ["#hero img"], html: "<img>" }]),
  ];
  check("g: untagged legacy node counts", countByImpact(violations).critical === 1);
}

if (failures.length > 0) {
  console.error(`✗ FAIL — embed exclusion: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("✓ PASS — embed exclusion: YouTube findings are reported but never counted.");
