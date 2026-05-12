import { parseArgs } from "node:util";
import type { PackageRecord, ProjectRollup } from "./types.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    in: { type: "string" },
    out: { type: "string" },
    columns: { type: "string" },
    sort: { type: "string" },
    desc: { type: "boolean" },
    "direct-only": { type: "boolean" },
    limit: { type: "string" },
    format: { type: "string" }, // table | tsv | json | html
  },
});

const inPath = values.in ?? "audit.json";
const directOnly = values["direct-only"] === true;
const limit = values.limit ? Number(values.limit) : Infinity;
const format = values.format ?? "table";

const data = (await Bun.file(inPath).json()) as { project: ProjectRollup; packages: PackageRecord[] };

// Risk tiers — every rule is a single observable signal, listed top-to-bottom
// from highest to lowest concern. A row's tier is the first rule it matches;
// rows that match nothing land in `ok`. The order is a value call that is
// stated openly here and reproduced in the HTML footer.
const RISK_TIERS: Array<{ rank: number; key: string; label: string; match: (p: PackageRecord) => boolean }> = [
  { rank: 1, key: "cve-unpatched", label: "unpatched-CVE", match: (p) => (p.osv?.unpatched_open_advisories ?? 0) > 0 },
  { rank: 2, key: "integrity-mismatch", label: "integrity-mismatch", match: (p) => p.npm?.integrity_matches_lockfile === false },
  { rank: 3, key: "archived", label: "archived", match: (p) => p.github?.repo_archived === true },
  { rank: 4, key: "deprecated", label: "deprecated", match: (p) => p.npm?.deprecated != null && p.npm.deprecated !== "" },
  { rank: 5, key: "stale-commit", label: "stale-commit-12mo", match: (p) => (p.github?.days_since_last_commit ?? -1) > 365 },
  { rank: 6, key: "solo-committer", label: "solo-committer-12mo", match: (p) => p.github?.committers_12mo === 1 },
];

function riskTierOf(p: PackageRecord): { rank: number; label: string } {
  for (const t of RISK_TIERS) if (t.match(p)) return { rank: t.rank, label: t.label };
  return { rank: 99, label: "ok" };
}

type ColumnSpec = {
  key: string;
  header: string;
  get: (p: PackageRecord) => string | number | null | undefined | boolean;
  align?: "left" | "right";
  /** One-line explanation shown as a tooltip in the HTML report. */
  description?: string;
};

const ALL_COLUMNS: Record<string, ColumnSpec> = {
  name: { key: "name", header: "name", get: (p) => p.name, description: "Package name as published on npm." },
  risk_tier: {
    key: "risk_tier",
    header: "tier",
    get: (p) => riskTierOf(p).label,
    description:
      "First risk tier this package matches, in fixed order: unpatched-CVE → integrity-mismatch → archived → deprecated → stale-commit-12mo (>365 days since last commit) → solo-committer-12mo. 'ok' = matches none. The tier ordering is a value call, named openly; each tier itself is a single observable signal with no weighting.",
  },
  version: { key: "version", header: "version", get: (p) => p.version, description: "Resolved version from bun.lock." },
  direct: {
    key: "direct",
    header: "dir",
    get: (p) => (p.direct ? "Y" : ""),
    description:
      "Y when this name is declared in any workspace package.json. Marked on the highest version when the same name resolves to multiple versions in the tree.",
  },
  depth: {
    key: "depth",
    header: "depth",
    get: (p) => p.depth,
    align: "right",
    description:
      "Shortest path from the root to this package in the dependency graph. 1 = a direct dep; higher = transitive. 0 means it's reachable only via optional/peer deps that the BFS skipped.",
  },
  importers: {
    key: "importers",
    header: "imp",
    get: (p) => p.importers_in_tree,
    align: "right",
    description:
      "How many other packages in this lockfile depend on this one. High = central; if this package breaks, many things break with it.",
  },

  publish_days: {
    key: "publish_days",
    header: "pub-d",
    get: (p) => p.npm?.days_since_latest_publish,
    align: "right",
    description: "Days since the latest version (any version) was published to npm. Source: registry.npmjs.org time map.",
  },
  commit_days: {
    key: "commit_days",
    header: "commit-d",
    get: (p) => p.github?.days_since_last_commit,
    align: "right",
    description: "Days since the most recent commit on the default branch. Source: GitHub GraphQL.",
  },
  maintainers: {
    key: "maintainers",
    header: "npm-pub",
    get: (p) => p.npm?.npm_maintainers_count,
    align: "right",
    description:
      "Number of npm accounts authorised to publish new versions of this package. NOT the number of code contributors — see 'committers' for that. Big projects often have very few publish accounts even when hundreds of people commit code.",
  },
  committers: {
    key: "committers",
    header: "committers",
    get: (p) => p.github?.committers_12mo,
    align: "right",
    description:
      "Distinct non-bot commit authors in the last 12 months on the default branch. Capped at the first 1000 commits — see commits_12mo_truncated in raw JSON.",
  },
  commits: {
    key: "commits",
    header: "commits",
    get: (p) => p.github?.commits_12mo,
    align: "right",
    description: "Total non-bot commits in the last 12 months on the default branch.",
  },
  top1: {
    key: "top1",
    header: "top1%",
    get: (p) => {
      const v = p.github?.top_committer_commit_share_12mo;
      return v != null ? Math.round(v * 100) : null;
    },
    align: "right",
    description:
      "Share of last-12-month commits authored by the single most active contributor. 100 = solo; lower = more distributed.",
  },
  top2: {
    key: "top2",
    header: "top2%",
    get: (p) => {
      const c2 = p.github?.top2_committer_commit_share_12mo;
      const c1 = p.github?.top_committer_commit_share_12mo;
      if (c2 == null || c1 == null) return null;
      return Math.round((c2 - c1) * 100);
    },
    align: "right",
    description:
      "Share of last-12-month commits authored by the SECOND most active contributor alone. Per-rank, not cumulative — top1% + top2% + top3% + tail% should add to ~100.",
  },
  top3: {
    key: "top3",
    header: "top3%",
    get: (p) => {
      const c3 = p.github?.top3_committer_commit_share_12mo;
      const c2 = p.github?.top2_committer_commit_share_12mo;
      if (c3 == null || c2 == null) return null;
      return Math.round((c3 - c2) * 100);
    },
    align: "right",
    description:
      "Share of last-12-month commits authored by the THIRD most active contributor alone. Per-rank, not cumulative.",
  },
  tail: {
    key: "tail",
    header: "tail%",
    get: (p) => {
      const v = p.github?.top3_committer_commit_share_12mo;
      return v != null ? Math.round((1 - v) * 100) : null;
    },
    align: "right",
    description:
      "Share of last-12-month commits authored by contributors OUTSIDE the top three. High tail with many committers = healthy bus factor; low tail = top three own everything.",
  },

  releases_12: {
    key: "releases_12",
    header: "rel/12m",
    get: (p) => p.npm?.releases_12mo,
    align: "right",
    description: "Number of versions published to npm in the last 12 months. Counts patch + minor + major releases.",
  },
  majors_24: {
    key: "majors_24",
    header: "maj/24m",
    get: (p) => p.npm?.major_bumps_24mo,
    align: "right",
    description: "Number of major version bumps (semver X.0.0) published in the last 24 months. High = API instability.",
  },

  dl_wk: {
    key: "dl_wk",
    header: "dl/wk",
    get: (p) => p.npm?.weekly_downloads,
    align: "right",
    description: "Downloads in the last 7 days. Source: api.npmjs.org/downloads.",
  },
  dep_pkgs: {
    key: "dep_pkgs",
    header: "dep-pkgs",
    get: (p) => p.ecosystems?.dependent_packages_count,
    align: "right",
    description: "Number of other npm packages that depend on this one. Source: packages.ecosyste.ms.",
  },
  dep_repos: {
    key: "dep_repos",
    header: "dep-repos",
    get: (p) => p.ecosystems?.dependent_repos_count,
    align: "right",
    description: "Number of public source repositories that depend on this package. Source: packages.ecosyste.ms.",
  },

  scorecard: {
    key: "scorecard",
    header: "score",
    get: (p) => p.depsdev?.scorecard_overall,
    align: "right",
    description:
      "OpenSSF Scorecard overall score, 0–10. Aggregates security best-practice checks (code review, fuzzing, signed releases, dependency updates, etc). Source: deps.dev. Null when the repo isn't in the Scorecard index.",
  },
  maintained: {
    key: "maintained",
    header: "sc-maint",
    get: (p) => p.depsdev?.scorecard_maintained,
    align: "right",
    description:
      "OpenSSF Scorecard 'Maintained' sub-score, 0–10. Based on recent commit and issue activity over the last 90 days. Source: deps.dev / Scorecard.",
  },

  integrity: {
    key: "integrity",
    header: "intg",
    get: (p) => {
      const m = p.npm?.integrity_matches_lockfile;
      if (m === true) return "ok";
      if (m === false) return "MISMATCH";
      if (p.lockfile_integrity === null) return "no-lock";
      return "no-reg";
    },
    description:
      "Compares the sha512 integrity recorded in bun.lock with the current dist.integrity served by the npm registry for the same version. ok = match; MISMATCH = registry now serves a different artefact than the lock recorded (possible republish or supply-chain swap); no-lock = lockfile has no integrity field; no-reg = registry has no integrity field.",
  },

  cves_total: {
    key: "cves_total",
    header: "cve-tot",
    get: (p) => p.osv?.advisories_total,
    align: "right",
    description: "All-time advisories published for this package (any version). Source: api.osv.dev.",
  },
  cves_unpatched: {
    key: "cves_unpatched",
    header: "cve-unp",
    get: (p) => p.osv?.unpatched_open_advisories,
    align: "right",
    description:
      "Advisories where the resolved version in bun.lock is still inside an affected version range. Source: api.osv.dev.",
  },
  cve_fix_d: {
    key: "cve_fix_d",
    header: "cve-fix-d",
    get: (p) => {
      const v = p.osv?.mean_days_advisory_to_patched_release_24mo;
      return v != null ? Math.round(v) : null;
    },
    align: "right",
    description:
      "Mean days from advisory publication to a release containing the fix, across advisories in the last 24 months. Lower = faster security response. Blank when no advisories or no patched releases found.",
  },

  archived: {
    key: "archived",
    header: "arch",
    get: (p) => (p.github?.repo_archived ? "Y" : ""),
    description: "Y when the source GitHub repository is marked archived (no further development).",
  },
  deprecated: {
    key: "deprecated",
    header: "dep",
    get: (p) => (p.npm?.deprecated ? "Y" : ""),
    description: "Y when the npm package or this specific version has been deprecated by its maintainer.",
  },

  open_issues: {
    key: "open_issues",
    header: "issues",
    get: (p) => p.github?.open_issues,
    align: "right",
    description: "Open issue count on the source GitHub repository (any age).",
  },
  oldest_issue: {
    key: "oldest_issue",
    header: "oldest-d",
    get: (p) => p.github?.oldest_open_issue_age_days,
    align: "right",
    description: "Age in days of the oldest still-open issue. High = backlog accumulation.",
  },

  cons_opened: {
    key: "cons_opened",
    header: "c-opened",
    get: (p) => p.responsiveness?.consumer_issues_opened_12mo,
    align: "right",
    description:
      "Consumer-authored issues opened in the last 12 months. Consumer = author_association in {NONE, FIRST_TIME_CONTRIBUTOR, CONTRIBUTOR}, excluding bots.",
  },
  cons_no_resp: {
    key: "cons_no_resp",
    header: "no-resp",
    get: (p) => p.responsiveness?.consumer_issues_no_response_12mo,
    align: "right",
    description:
      "Consumer issues from the last 12 months that received no non-bot comment and remain open. The clearest 'ignored' signal.",
  },
  cons_resolved: {
    key: "cons_resolved",
    header: "resolved",
    get: (p) => p.responsiveness?.consumer_issues_resolved_12mo,
    align: "right",
    description:
      "Consumer issues closed with state_reason=completed AND at least one maintainer comment. The positive engagement bucket.",
  },
  first_resp_h: {
    key: "first_resp_h",
    header: "first-resp-h",
    get: (p) => {
      const v = p.responsiveness?.median_first_maintainer_response_hours_12mo;
      return v != null ? Math.round(v) : null;
    },
    align: "right",
    description:
      "Median hours from issue open to first comment by an OWNER/MEMBER/COLLABORATOR (last 12 months). Excludes issues that never got a maintainer reply.",
  },
  p90_resp_h: {
    key: "p90_resp_h",
    header: "p90-resp-h",
    get: (p) => {
      const v = p.responsiveness?.p90_first_maintainer_response_hours_12mo;
      return v != null ? Math.round(v) : null;
    },
    align: "right",
    description:
      "90th-percentile hours to first maintainer response. Catches the slow-tail cases the median hides.",
  },
  awaiting: {
    key: "awaiting",
    header: "awaiting",
    get: (p) => p.responsiveness?.issues_still_awaiting_first_response,
    align: "right",
    description: "Open consumer issues with zero maintainer comments to date.",
  },
};

const DEFAULT_COLUMNS = [
  "name",
  "direct",
  "depth",
  "importers",
  "committers",
  "top1",
  "top2",
  "top3",
  "tail",
  "publish_days",
  "commit_days",
  "releases_12",
  "scorecard",
  "cves_total",
  "cves_unpatched",
  "cve_fix_d",
  "dep_pkgs",
  "cons_no_resp",
  "cons_resolved",
  "first_resp_h",
  "integrity",
  "archived",
  "deprecated",
];

const columnKeys = values.columns ? values.columns.split(",").map((s) => s.trim()) : DEFAULT_COLUMNS;
// When sorting by risk, surface the tier label so the ordering is auditable.
if (values.sort === "risk" && !columnKeys.includes("risk_tier")) {
  const nameIdx = columnKeys.indexOf("name");
  columnKeys.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, "risk_tier");
}
const columns = columnKeys.map((k) => {
  const c = ALL_COLUMNS[k];
  if (!c) throw new Error(`Unknown column: ${k}. Available: ${Object.keys(ALL_COLUMNS).join(", ")}`);
  return c;
});

let packages = data.packages;
if (directOnly) packages = packages.filter((p) => p.direct);

if (values.sort === "risk") {
  // Tier-based sort. Primary key: risk tier rank (lower = more concerning).
  // Tiebreakers, all observable: unpatched CVEs desc, days since last commit
  // desc, weekly downloads desc (more downstream blast radius first), name asc.
  packages = [...packages].sort((a, b) => {
    const ta = riskTierOf(a).rank;
    const tb = riskTierOf(b).rank;
    if (ta !== tb) return ta - tb;
    const ua = a.osv?.unpatched_open_advisories ?? 0;
    const ub = b.osv?.unpatched_open_advisories ?? 0;
    if (ua !== ub) return ub - ua;
    const ca = a.github?.days_since_last_commit ?? -1;
    const cb = b.github?.days_since_last_commit ?? -1;
    if (ca !== cb) return cb - ca;
    const da = a.npm?.weekly_downloads ?? 0;
    const db = b.npm?.weekly_downloads ?? 0;
    if (da !== db) return db - da;
    return a.name.localeCompare(b.name);
  });
} else if (values.sort) {
  const sortCol = ALL_COLUMNS[values.sort];
  if (!sortCol) throw new Error(`Unknown sort column: ${values.sort}`);
  const desc = values.desc === true;
  packages = [...packages].sort((a, b) => {
    const av = sortCol.get(a);
    const bv = sortCol.get(b);
    const an = typeof av === "number" ? av : av == null ? -Infinity : 0;
    const bn = typeof bv === "number" ? bv : bv == null ? -Infinity : 0;
    return desc ? bn - an : an - bn;
  });
}

if (Number.isFinite(limit)) packages = packages.slice(0, limit);

function fmtCell(v: unknown): string {
  if (v == null) return "·";
  if (typeof v === "number") return v.toString();
  if (typeof v === "boolean") return v ? "Y" : "";
  return String(v);
}

if (format === "json") {
  console.log(JSON.stringify(packages, null, 2));
  process.exit(0);
}

if (format === "tsv") {
  console.log(columns.map((c) => c.header).join("\t"));
  for (const p of packages) {
    console.log(columns.map((c) => fmtCell(c.get(p))).join("\t"));
  }
  process.exit(0);
}

if (format === "html") {
  const outFile = values.out ?? "audit.html";
  const html = renderHtml(data.project, packages, columns);
  await Bun.write(outFile, html);
  console.error(`[report] wrote ${outFile} — open in a browser to view`);
  process.exit(0);
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderHtml(
  project: ProjectRollup,
  pkgs: PackageRecord[],
  cols: ColumnSpec[],
): string {
  const rowsData = pkgs.map((p) =>
    cols.map((c) => {
      const v = c.get(p);
      return { display: fmtCell(v), sortVal: typeof v === "number" ? v : v == null ? null : String(v) };
    }),
  );
  const headers = cols.map((c) => ({
    header: c.header,
    align: c.align ?? "left",
    key: c.key,
    description: c.description ?? "",
  }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bun-audit report — ${escapeHtml(project.lockfile_path)}</title>
<style>
:root {
  --bg: #fafaf8;
  --fg: #111;
  --muted: #888;
  --border: #ddd;
  --row-alt: #f0efeb;
  --warn: #fff4d6;
  --bad: #ffd9d9;
  --good: #e3f4dc;
}
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 16px; }
h1 { font-size: 16px; margin: 0 0 4px; font-weight: 600; }
.meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
.rollup { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; margin-bottom: 12px; }
.rollup span { background: white; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; }
.rollup strong { color: var(--fg); }
.controls { margin-bottom: 8px; font-size: 13px; }
.controls input { padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; min-width: 240px; }
.controls label { color: var(--muted); margin-right: 8px; }
table { border-collapse: collapse; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; width: 100%; background: white; }
thead { position: sticky; top: 0; background: white; box-shadow: 0 1px 0 var(--border); z-index: 1; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
th { cursor: pointer; user-select: none; font-weight: 600; text-decoration: underline dotted var(--muted); text-underline-offset: 4px; position: relative; }
th:hover { background: var(--row-alt); }
th .arrow { color: var(--muted); margin-left: 4px; font-size: 10px; }
th[data-tip]:hover::after {
  content: attr(data-tip);
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  background: #222;
  color: white;
  padding: 8px 10px;
  border-radius: 4px;
  font-weight: normal;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 11px;
  line-height: 1.4;
  text-decoration: none;
  white-space: normal;
  max-width: 360px;
  width: max-content;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  pointer-events: none;
}
.right { text-align: right; }
tr:nth-child(even) td { background: var(--row-alt); }
.muted { color: var(--muted); }
.bad { background: var(--bad) !important; }
.warn { background: var(--warn) !important; }
.good { background: var(--good) !important; }
.footer { color: var(--muted); font-size: 11px; margin-top: 12px; }
</style>
</head>
<body>
<h1>bun-audit — ${escapeHtml(project.lockfile_path)}</h1>
<div class="meta">generated ${escapeHtml(project.generated_at)} · ${pkgs.length} rows shown</div>
<div class="rollup">
  <span>direct <strong>${project.total_direct_deps}</strong></span>
  <span>transitive <strong>${project.total_transitive_deps}</strong></span>
  <span>unique <strong>${project.unique_packages}</strong></span>
  <span>orgs <strong>${project.unique_orgs}</strong></span>
  <span>maintainers <strong>${project.unique_npm_maintainers}</strong></span>
  <span>no-publish-12mo <strong>${project.packages_no_publish_12mo}</strong></span>
  <span>no-commit-12mo <strong>${project.packages_no_commit_12mo}</strong></span>
  <span>solo-committer <strong>${project.packages_solo_committer_12mo}</strong></span>
  <span>archived <strong>${project.packages_archived}</strong></span>
  <span>deprecated <strong>${project.packages_deprecated}</strong></span>
  <span>unpatched-cves <strong>${project.packages_with_open_cves}</strong></span>
  <span>integrity-mismatch <strong>${project.packages_integrity_mismatch}</strong></span>
</div>
<div class="controls">
  <label>filter</label><input id="filter" placeholder="type to filter rows (matches any cell)">
</div>
<table id="t">
<thead><tr>${headers
  .map(
    (h, i) =>
      `<th class="${h.align === "right" ? "right" : ""}" data-i="${i}" data-tip="${escapeHtml(h.description)}" title="${escapeHtml(h.description)}">${escapeHtml(h.header)}<span class="arrow"></span></th>`,
  )
  .join("")}</tr></thead>
<tbody>
${rowsData
  .map(
    (row) =>
      `<tr>${row
        .map((cell, i) => {
          const c = cols[i];
          const cls: string[] = [];
          if (c.align === "right") cls.push("right");
          if (cell.display === "·") cls.push("muted");
          // Objective threshold highlights (all rules are visible here and
          // never invented composites).
          if (c.key === "cves_unpatched" && typeof cell.sortVal === "number" && cell.sortVal > 0) cls.push("bad");
          if (c.key === "deprecated" && cell.display === "Y") cls.push("warn");
          if (c.key === "archived" && cell.display === "Y") cls.push("warn");
          if (c.key === "integrity" && cell.display === "MISMATCH") cls.push("bad");
          if (c.key === "top1" && typeof cell.sortVal === "number" && cell.sortVal >= 90) cls.push("warn");
          if (c.key === "risk_tier") {
            if (cell.display === "unpatched-CVE" || cell.display === "integrity-mismatch") cls.push("bad");
            else if (cell.display === "archived" || cell.display === "deprecated") cls.push("warn");
            else if (cell.display === "ok") cls.push("muted");
          }
          return `<td class="${cls.join(" ")}" data-sort="${cell.sortVal == null ? "" : escapeHtml(String(cell.sortVal))}">${escapeHtml(cell.display)}</td>`;
        })
        .join("")}</tr>`,
  )
  .join("\n")}
</tbody>
</table>
<div class="footer">
Objective thresholds shown via colour: red = unpatched CVE present or integrity mismatch; amber = archived repo, deprecated package, or top-1 committer share ≥ 90%. No composite scoring is implied — every coloured cell maps to a single observable rule. Sort by clicking a header. Filter applies across all visible cells.
<br><br>
<strong>Risk-tier sort (--sort risk):</strong> rows are bucketed by the first rule they match, top to bottom: (1) unpatched-CVE, (2) integrity-mismatch, (3) archived, (4) deprecated, (5) stale-commit-12mo (&gt;365 days since last commit), (6) solo-committer-12mo, else 'ok'. Within a tier, tiebreakers are unpatched-CVE count, then days-since-last-commit, then weekly downloads, then name. The tier order itself is a value call, listed openly here; each tier is one observable signal.
</div>
<script>
(function() {
  const t = document.getElementById("t");
  const tbody = t.tBodies[0];
  let sortIdx = -1;
  let sortDir = 1;
  function clearArrows() { t.querySelectorAll("th .arrow").forEach((a) => (a.textContent = "")); }
  t.tHead.addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (!th) return;
    const i = Number(th.dataset.i);
    if (i === sortIdx) sortDir = -sortDir;
    else { sortIdx = i; sortDir = 1; }
    clearArrows();
    th.querySelector(".arrow").textContent = sortDir > 0 ? "▲" : "▼";
    const rows = [...tbody.rows];
    rows.sort((a, b) => {
      const av = a.cells[i].dataset.sort;
      const bv = b.cells[i].dataset.sort;
      const an = av === "" ? -Infinity : (isNaN(Number(av)) ? av : Number(av));
      const bn = bv === "" ? -Infinity : (isNaN(Number(bv)) ? bv : Number(bv));
      if (an === bn) return 0;
      return (an > bn ? 1 : -1) * sortDir;
    });
    rows.forEach((r) => tbody.appendChild(r));
  });
  document.getElementById("filter").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    [...tbody.rows].forEach((r) => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });
})();
</script>
</body>
</html>
`;
}

// Default: aligned table
const widths = columns.map((c) => c.header.length);
const rows = packages.map((p) =>
  columns.map((c, i) => {
    const s = fmtCell(c.get(p));
    if (s.length > widths[i]) widths[i] = s.length;
    return s;
  }),
);

function pad(s: string, w: number, align: "left" | "right" = "left"): string {
  if (s.length >= w) return s;
  const fill = " ".repeat(w - s.length);
  return align === "right" ? fill + s : s + fill;
}

const headerLine = columns.map((c, i) => pad(c.header, widths[i], c.align)).join("  ");
const sepLine = columns.map((_, i) => "-".repeat(widths[i])).join("  ");
console.log(headerLine);
console.log(sepLine);
for (const r of rows) {
  console.log(r.map((s, i) => pad(s, widths[i], columns[i].align)).join("  "));
}

console.error(`\n[report] ${packages.length} packages shown. Project totals: direct=${data.project.total_direct_deps} transitive=${data.project.total_transitive_deps} archived=${data.project.packages_archived} deprecated=${data.project.packages_deprecated} solo_committer=${data.project.packages_solo_committer_12mo} unpatched_cves=${data.project.packages_with_open_cves}`);
