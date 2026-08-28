// test/check-suppressions.js — unit test for verified-false-positive handling
// (scan-core.mjs).
//
// The risk this feature carries is that it quietly becomes a way to make the
// numbers look better. Most of what is asserted here is therefore about the
// guardrails, not the happy path: required justification, mandatory expiry,
// narrow matching, and loud failure on a malformed file.

import {
  compileSuppressions,
  tagSuppressions,
  expiredSuppressionsInUse,
  countByImpact,
  countedNodes,
  suppressedTotal,
} from "../scan-core.mjs";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}
function throws(name, fn, matcher) {
  try {
    fn();
    failures.push(`${name} (expected a throw, got none)`);
  } catch (err) {
    if (matcher && !matcher.test(err.message)) {
      failures.push(`${name} (threw "${err.message}", which does not match ${matcher})`);
    }
  }
}

const TODAY = new Date("2026-08-20T12:00:00Z");
const PAGE = "https://www.nyc.gov/content/summer/pages/";

const entry = (over = {}) => ({
  site: "Summer",
  page: PAGE,
  rule: "color-contrast",
  selector: ".hero-banner h1",
  reason: "Contrast measured 7.1:1 against the painted background.",
  verified_on: "2026-08-20",
  expires: "2027-02-20",
  ...over,
});

const violation = (id, impact, targets) => ({
  id,
  impact,
  description: `${id} description`,
  help: `${id} help`,
  helpUrl: `https://example.com/${id}`,
  tags: ["wcag2aa"],
  nodes: targets.map((t) => ({ target: t, html: "<x>" })),
});

// (a) Required fields. Each omission must fail the whole scan, not skip the
// entry — a suppression that silently fails to load leaves plausible numbers.
{
  for (const field of ["site", "rule", "selector", "reason", "verified_on", "expires"]) {
    throws(
      `a: missing ${field} is fatal`,
      () => compileSuppressions([entry({ [field]: undefined })], { today: TODAY }),
      new RegExp(field)
    );
  }
  throws(
    "a: empty reason is fatal",
    () => compileSuppressions([entry({ reason: "   " })], { today: TODAY }),
    /reason/
  );
  throws(
    "a: neither page nor pagePattern is fatal",
    () => compileSuppressions([entry({ page: undefined })], { today: TODAY }),
    /pagePattern/
  );
  throws(
    "a: both page and pagePattern is fatal",
    () => compileSuppressions([entry({ pagePattern: "https://*" })], { today: TODAY }),
    /not both/
  );
  throws(
    "a: non-array file is fatal",
    () => compileSuppressions({ site: "x" }, { today: TODAY }),
    /array/
  );
}

// (b) Dates must be real and ordered — expiry is the guardrail that stops this
// file becoming a graveyard, so a malformed one cannot be waved through.
{
  throws(
    "b: bad date format is fatal",
    () => compileSuppressions([entry({ expires: "Feb 2027" })], { today: TODAY }),
    /YYYY-MM-DD/
  );
  throws(
    "b: expiry before verification is fatal",
    () => compileSuppressions([entry({ expires: "2026-01-01" })], { today: TODAY }),
    /after/
  );
}

// (c) An active entry suppresses its node; counts and tier drop it.
{
  const sup = compileSuppressions([entry()], { today: TODAY });
  check("c: one active", sup.active.length === 1 && sup.expired.length === 0);
  const violations = [violation("color-contrast", "serious", [[".hero-banner h1"], ["main p"]])];
  tagSuppressions(violations, PAGE, sup);
  check("c: matched node suppressed", violations[0].nodes[0].suppressed !== undefined);
  check("c: other node untouched", violations[0].nodes[1].suppressed === undefined);
  check("c: only one counts", countByImpact(violations).serious === 1);
  check("c: reason is carried through", /7\.1:1/.test(violations[0].nodes[0].suppressed.reason));
  check("c: node is retained, not deleted", violations[0].nodes.length === 2);
  check("c: suppressedTotal reports it", suppressedTotal(violations) === 1);
}

// (d) Matching is narrow: same rule on a different page, or a different rule on
// the same page, must NOT be suppressed. A site-wide suppression would hide
// genuinely new failures.
{
  const sup = compileSuppressions([entry()], { today: TODAY });
  const other = [violation("color-contrast", "serious", [[".hero-banner h1"]])];
  tagSuppressions(other, "https://www.nyc.gov/content/summer/pages/events", sup);
  check("d: different page not suppressed", other[0].nodes[0].suppressed === undefined);

  const otherRule = [violation("link-name", "serious", [[".hero-banner h1"]])];
  tagSuppressions(otherRule, PAGE, sup);
  check("d: different rule not suppressed", otherRule[0].nodes[0].suppressed === undefined);

  const otherSel = [violation("color-contrast", "serious", [[".footer h1"]])];
  tagSuppressions(otherSel, PAGE, sup);
  check("d: different selector not suppressed", otherSel[0].nodes[0].suppressed === undefined);
}

// (e) Selector matching ignores axe's attribute selectors, which it regenerates
// unstably between runs — an exact-string match would silently stop working.
{
  const sup = compileSuppressions([entry()], { today: TODAY });
  const violations = [violation("color-contrast", "serious", [['.hero-banner h1[data-v="7"]']])];
  tagSuppressions(violations, PAGE, sup);
  check("e: attribute churn still matches", violations[0].nodes[0].suppressed !== undefined);
}

// (f) An expired entry does not apply, and is reported when it still matches so
// it gets renewed or deleted rather than rotting.
{
  const sup = compileSuppressions(
    [entry({ verified_on: "2026-01-01", expires: "2026-08-19" })],
    { today: TODAY }
  );
  check("f: classified expired", sup.expired.length === 1 && sup.active.length === 0);
  const violations = [violation("color-contrast", "serious", [[".hero-banner h1"]])];
  tagSuppressions(violations, PAGE, sup);
  check("f: expired does not suppress", violations[0].nodes[0].suppressed === undefined);
  check("f: expired counts again", countByImpact(violations).serious === 1);
  check("f: expired-in-use reported", expiredSuppressionsInUse(violations, PAGE, sup).length === 1);
}

// (g) pagePattern covers templated pages that repeat one false positive, and is
// still bounded by rule + selector.
{
  const sup = compileSuppressions(
    [entry({ page: undefined, pagePattern: "https://www.nyc.gov/content/summer/*" })],
    { today: TODAY }
  );
  const inScope = [violation("color-contrast", "serious", [[".hero-banner h1"]])];
  tagSuppressions(inScope, "https://www.nyc.gov/content/summer/pages/events", sup);
  check("g: pattern matches in scope", inScope[0].nodes[0].suppressed !== undefined);

  const outOfScope = [violation("color-contrast", "serious", [[".hero-banner h1"]])];
  tagSuppressions(outOfScope, "https://www.nyc.gov/content/oti/pages/home", sup);
  check("g: pattern does not leak", outOfScope[0].nodes[0].suppressed === undefined);

  // The pattern must not be usable as a regex injection that widens scope.
  const dotted = [violation("color-contrast", "serious", [[".hero-banner h1"]])];
  tagSuppressions(dotted, "https://www.nyc.gov/contentXsummer/pages/", sup);
  check("g: '.' in a pattern is literal", dotted[0].nodes[0].suppressed === undefined);
}

// (h) selector "*" widens to every node of that rule on that page — allowed,
// but only as an explicit choice, never as the result of omitting the field.
{
  const sup = compileSuppressions([entry({ selector: "*" })], { today: TODAY });
  const violations = [violation("color-contrast", "serious", [["a"], ["b"], ["c"]])];
  tagSuppressions(violations, PAGE, sup);
  check("h: wildcard covers all nodes", countedNodes(violations[0]).length === 0);
}

// (h2) A node already excluded as embed markup is not tagged twice — it needs
// no second reason, and double-tagging double-counts it across the two totals.
{
  const sup = compileSuppressions([entry({ selector: "*" })], { today: TODAY });
  const violations = [violation("color-contrast", "serious", [["iframe", "span"], ["main p"]])];
  violations[0].nodes[0].embed = { vendor: "YouTube", url: "https://youtube.com/x" };
  tagSuppressions(violations, PAGE, sup);
  check("h2: embed node not also suppressed", violations[0].nodes[0].suppressed === undefined);
  check("h2: non-embed node still suppressed", violations[0].nodes[1].suppressed !== undefined);
  check("h2: totals stay disjoint", suppressedTotal(violations) === 1);
}

// (i) No suppressions file at all is the normal case and must be a no-op.
{
  const violations = [violation("color-contrast", "serious", [[".hero-banner h1"]])];
  tagSuppressions(violations, PAGE, null);
  check("i: null suppressions is a no-op", countByImpact(violations).serious === 1);
}

if (failures.length > 0) {
  console.error(`✗ FAIL — suppressions:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("✓ PASS — suppressions: narrow, justified, expiring, and never deleted.");
