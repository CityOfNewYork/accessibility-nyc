// test/check-core-shared.js — fail the build if a scanner grows its own copy
// of a scoring rule instead of importing it from scan-core.mjs.
//
// This exists because the previous mechanism was a comment reading "mirror
// scan.js — keep in sync", and it did not work: scan-finders.mjs redefined
// tierFor so that serious-without-critical graded RED, while scan.js graded the
// same counts ORANGE. Two agency apps were published a full tier worse than
// their findings warranted, for months, silently.
//
// A shared module stops the drift only if nobody re-adds a local copy. This
// test is the part that notices. It is deliberately dumb — source-text checks,
// no behavioral cleverness — because it has to keep working when someone who
// has never read scan-core.mjs adds a helper in a hurry.

import { readFile } from "node:fs/promises";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const SCANNERS = ["scan.js", "scan-finders.mjs"];

// Names that decide what counts, what a tier means, or what reaches history.
// A scanner may CALL these; it may not DEFINE them.
const SHARED = [
  "tierFor",
  "countByImpact",
  "addCounts",
  "emptyCounts",
  "countedNodes",
  "countedTotal",
  "countedRules",
  "embedTotal",
  "rulesForHistory",
  "slimViolations",
  "slimIncomplete",
  "settlePage",
  "tagEmbedNodes",
  "tagEmbeds",
  "embedFrameMap",
  "pageEmbeds",
  "excludedEmbedFor",
  "suppressedTotal",
  "compileSuppressions",
  "tagSuppressions",
  "expiredSuppressionsInUse",
  "stripAttrSelectors",
  "normTargetKey",
  "leafSelector",
  "EXCLUDED_EMBEDS",
  "WCAG_TAGS",
];

const sources = Object.fromEntries(
  await Promise.all(SCANNERS.map(async (f) => [f, await readFile(f, "utf8")]))
);
const core = await readFile("scan-core.mjs", "utf8");

for (const [file, src] of Object.entries(sources)) {
  check(`${file} imports from scan-core.mjs`, /from\s+"\.\/scan-core\.mjs"/.test(src));

  for (const name of SHARED) {
    // A local definition of a shared name: function decl, or const/let/var
    // binding at any indentation. Import lines are stripped first so the
    // import list itself never trips the check.
    const withoutImports = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";/g, "");
    const declared = new RegExp(
      `(^|\\n)\\s*(export\\s+)?(async\\s+)?(function\\s+${name}\\b|(const|let|var)\\s+${name}\\b)`
    ).test(withoutImports);
    check(`${file} must not define ${name} locally — import it from scan-core.mjs`, !declared);
  }
}

// The shared module must actually export everything the list names, or the
// check above would be guarding names that no longer exist.
for (const name of SHARED) {
  const exported = new RegExp(
    `export\\s+(async\\s+)?(function\\s+${name}\\b|(const|let)\\s+${name}\\b)`
  ).test(core);
  check(`scan-core.mjs must export ${name}`, exported);
}

// The specific regression that motivated all of this: one tier definition,
// and serious-without-critical is orange, not red.
{
  const { tierFor } = await import("../scan-core.mjs");
  check(
    "serious without critical is orange",
    tierFor({ critical: 0, serious: 3, moderate: 0, minor: 0 }) === "orange"
  );
  check(
    "critical is red",
    tierFor({ critical: 1, serious: 0, moderate: 0, minor: 0 }) === "red"
  );
  check(
    "moderate only is yellow",
    tierFor({ critical: 0, serious: 0, moderate: 2, minor: 0 }) === "yellow"
  );
  check(
    "nothing is green",
    tierFor({ critical: 0, serious: 0, moderate: 0, minor: 0 }) === "green"
  );
}

if (failures.length > 0) {
  console.error(`✗ FAIL — scanner drift:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("✓ PASS — scanners share one definition of what counts and what a tier means.");
