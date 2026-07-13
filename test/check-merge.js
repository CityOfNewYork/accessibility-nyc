// test/check-merge.js — unit test for mergeViewportViolations (scan.js).
// Hand-built desktop/mobile slim-violation fixtures, asserting the dedup and
// viewport-tagging contract the dashboard relies on: violation-level
// `viewports` is the union across nodes; node-level `viewports` appears only
// when it differs from the violation's; desktop wins node html on overlap;
// node counts stay dedup'd so countByImpact sees each unique node once.

import { mergeViewportViolations } from "../scan.js";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const node = (target, html = "<div>") => ({ target: [target], html, failureSummary: "fix it" });
const violation = (id, impact, nodes) => ({
  id,
  impact,
  description: `${id} description`,
  help: `${id} help`,
  helpUrl: `https://example.com/${id}`,
  tags: ["wcag2aa"],
  nodes,
});

// (a) Same rule + same target at both widths → one node, tagged both, and no
// redundant node-level viewports.
{
  const merged = mergeViewportViolations(
    [violation("image-alt", "critical", [node("#hero img", "<img desktop>")])],
    [violation("image-alt", "critical", [node("#hero img", "<img mobile>")])]
  );
  check("a: one violation", merged.length === 1);
  check("a: one node", merged[0].nodes.length === 1);
  check("a: viewports both", JSON.stringify(merged[0].viewports) === '["desktop","mobile"]');
  check("a: no node-level viewports", !("viewports" in merged[0].nodes[0]));
  // (d) Desktop wins the html snippet on overlap.
  check("d: desktop html wins", merged[0].nodes[0].html === "<img desktop>");
}

// (b) Rule that only fires at mobile → tagged ["mobile"].
{
  const merged = mergeViewportViolations(
    [],
    [violation("target-size", "serious", [node(".nav-toggle")])]
  );
  check("b: one violation", merged.length === 1);
  check("b: viewports mobile", JSON.stringify(merged[0].viewports) === '["mobile"]');
  check("b: no node-level viewports", !("viewports" in merged[0].nodes[0]));
}

// (c) Mixed rule: one shared node + one mobile-only node → violation tagged
// both, and every node carries its own (differing) viewports.
{
  const merged = mergeViewportViolations(
    [violation("color-contrast", "serious", [node("#footer a")])],
    [violation("color-contrast", "serious", [node("#footer a"), node(".mobile-menu a")])]
  );
  check("c: one violation", merged.length === 1);
  check("c: two nodes", merged[0].nodes.length === 2);
  check("c: viewports both", JSON.stringify(merged[0].viewports) === '["desktop","mobile"]');
  const shared = merged[0].nodes.find((n) => n.target[0] === "#footer a");
  const mobileOnly = merged[0].nodes.find((n) => n.target[0] === ".mobile-menu a");
  check("c: shared node untagged (matches union)", !("viewports" in shared));
  check("c: mobile-only node tagged", JSON.stringify(mobileOnly.viewports) === '["mobile"]');
}

// (e) Node math: desktop-only rule keeps its nodes; disjoint targets add up,
// shared targets don't double-count.
{
  const merged = mergeViewportViolations(
    [
      violation("link-name", "serious", [node("#a"), node("#b")]),
      violation("label", "critical", [node("#search")]),
    ],
    [violation("link-name", "serious", [node("#b"), node("#c")])]
  );
  const linkName = merged.find((v) => v.id === "link-name");
  const label = merged.find((v) => v.id === "label");
  check("e: shared node dedup'd", linkName.nodes.length === 3);
  check("e: desktop-only rule tagged", JSON.stringify(label.viewports) === '["desktop"]');
  check("e: desktop-only nodes untagged", label.nodes.every((n) => !("viewports" in n)));
}

// (f) Selector instability across passes: axe picked different disambiguating
// attributes for the same iframe on each pass (seen live on nyc.gov — the
// same embed came back [allowfullscreen=""] desktop, [width="640"] mobile).
// The structural path is identical, so the normalized fallback must merge
// them into one node tagged both.
{
  const merged = mergeViewportViolations(
    [violation("button-name", "critical", [
      { target: ['.wrap:nth-child(63) > iframe[title="x"][height="427"][allowfullscreen=""]', ".avatar"], html: "<button>", failureSummary: "fix it" },
    ])],
    [violation("button-name", "critical", [
      { target: ['.wrap:nth-child(63) > iframe[title="x"][height="427"][width="640"]', ".avatar"], html: "<button>", failureSummary: "fix it" },
    ])]
  );
  check("f: one node after normalized merge", merged[0].nodes.length === 1);
  check("f: viewports both", JSON.stringify(merged[0].viewports) === '["desktop","mobile"]');
}

// (g) The fallback must stay conservative: when two desktop nodes are told
// apart ONLY by attributes, a mobile node matching their shared structural
// path is ambiguous — keep it separate rather than guess.
{
  const merged = mergeViewportViolations(
    [violation("frame-title", "serious", [
      { target: ['iframe[height="315"]'], html: "<iframe a>", failureSummary: "fix it" },
      { target: ['iframe[height="427"]'], html: "<iframe b>", failureSummary: "fix it" },
    ])],
    [violation("frame-title", "serious", [
      { target: ['iframe[allowfullscreen=""]'], html: "<iframe ?>", failureSummary: "fix it" },
    ])]
  );
  check("g: ambiguous match kept separate", merged[0].nodes.length === 3);
}

// (h) The fallback only bridges the two passes: two distinct mobile nodes
// distinguished only by attributes are different elements and must not fold
// into each other after the first is appended.
{
  const merged = mergeViewportViolations(
    [violation("image-alt", "critical", [node("#logo")])],
    [violation("image-alt", "critical", [
      { target: ['img[src="a.png"]'], html: "<img a>", failureSummary: "fix it" },
      { target: ['img[src="b.png"]'], html: "<img b>", failureSummary: "fix it" },
    ])]
  );
  check("h: sibling mobile nodes stay distinct", merged[0].nodes.length === 3);
}

if (failures.length > 0) {
  console.error(`✗ FAIL — mergeViewportViolations: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("✓ PASS — mergeViewportViolations: dedup and viewport tagging behave as specified.");
