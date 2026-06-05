// report-summary.mjs — Render a per-site scan summary as Markdown for the
// GitHub Actions run page (the "Job Summary"). Reads results.json (current
// snapshot) + history.json (for the week-over-week delta) and appends to the
// file named by $GITHUB_STEP_SUMMARY. Run locally with no env set to preview
// the table on stdout.
//
// Usage:
//   node report-summary.mjs            # preview to stdout
//   DASHBOARD_URL=… node report-summary.mjs   # include a dashboard link

import { readFile, appendFile } from "node:fs/promises";

const TIER_EMOJI = { red: "🔴", yellow: "🟡", green: "🟢", error: "⚠️" };

// A history entry's total violation count is the sum of its per-rule counts.
const historyTotal = (entry) => (entry.rules || []).reduce((s, r) => s + r.count, 0);

// Signed change since the previous scan, with a direction marker. More
// violations is worse (▲), fewer is better (▼).
function formatDelta(current, previous) {
  if (previous == null) return "— *(new)*";
  const d = current - previous;
  if (d === 0) return "0";
  return d > 0 ? `▲ +${d}` : `▼ ${d}`;
}

const results = JSON.parse(await readFile("results.json", "utf8"));
let history = [];
try {
  history = JSON.parse(await readFile("history.json", "utf8"));
} catch {}

// Group history entries by site so we can find each site's previous run.
const entriesBySite = {};
for (const e of history) (entriesBySite[e.site] ||= []).push(e);

const lines = [];
lines.push(`## Accessibility scan — ${new Date().toISOString().slice(0, 10)}`);
lines.push("");
lines.push(`**Target:** ${results.wcag_target} · **Engine:** ${results.engine}`);
lines.push("");
lines.push("| Site | Status | Violations | Δ vs last | Rules | Pages |");
lines.push("|---|:--:|--:|:--:|--:|--:|");

let totalViolations = 0;
let totalPages = 0;
for (const s of results.sites) {
  const current = s.total_violations ?? 0;
  const sorted = (entriesBySite[s.name] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  // Last entry is this run; the one before it is the previous scan.
  const previous = sorted.length >= 2 ? historyTotal(sorted[sorted.length - 2]) : null;
  const pages = s.pages?.length ?? 1;
  totalViolations += current;
  totalPages += pages;
  lines.push(
    `| ${s.name} | ${TIER_EMOJI[s.tier] || s.tier} | ${current} | ${formatDelta(current, previous)} | ${s.distinct_rules ?? 0} | ${pages} |`
  );
}

lines.push("");
lines.push(
  `**Totals:** ${totalViolations} violations across ${totalPages} pages in ${results.sites.length} sites.`
);
lines.push("");
lines.push("<sub>Δ vs last = change in violation count since the previous scan (▲ more · ▼ fewer). Status by max severity: 🔴 critical/serious · 🟡 moderate/minor · 🟢 none · ⚠️ scan error.</sub>");

if (process.env.DASHBOARD_URL) {
  lines.push("");
  lines.push(`[View the full dashboard →](${process.env.DASHBOARD_URL})`);
}

const out = lines.join("\n") + "\n";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) await appendFile(summaryFile, out);
else process.stdout.write(out);
