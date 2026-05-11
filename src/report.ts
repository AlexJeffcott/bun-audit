import { parseArgs } from "node:util";
import type { PackageRecord, ProjectRollup } from "./types.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    in: { type: "string" },
    columns: { type: "string" },
    sort: { type: "string" },
    desc: { type: "boolean" },
    "direct-only": { type: "boolean" },
    limit: { type: "string" },
    format: { type: "string" }, // table | tsv | json
  },
});

const inPath = values.in ?? "audit.json";
const directOnly = values["direct-only"] === true;
const limit = values.limit ? Number(values.limit) : Infinity;
const format = values.format ?? "table";

const data = (await Bun.file(inPath).json()) as { project: ProjectRollup; packages: PackageRecord[] };

type ColumnSpec = {
  key: string;
  header: string;
  get: (p: PackageRecord) => string | number | null | undefined | boolean;
  align?: "left" | "right";
};

const ALL_COLUMNS: Record<string, ColumnSpec> = {
  name: { key: "name", header: "name", get: (p) => p.name },
  version: { key: "version", header: "version", get: (p) => p.version },
  direct: { key: "direct", header: "dir", get: (p) => (p.direct ? "Y" : "") },
  depth: { key: "depth", header: "depth", get: (p) => p.depth, align: "right" },
  importers: { key: "importers", header: "imp", get: (p) => p.importers_in_tree, align: "right" },

  publish_days: { key: "publish_days", header: "pub-d", get: (p) => p.npm?.days_since_latest_publish, align: "right" },
  commit_days: { key: "commit_days", header: "commit-d", get: (p) => p.github?.days_since_last_commit, align: "right" },
  maintainers: { key: "maintainers", header: "maint", get: (p) => p.npm?.npm_maintainers_count, align: "right" },
  committers: { key: "committers", header: "committers", get: (p) => p.github?.committers_12mo, align: "right" },
  commits: { key: "commits", header: "commits", get: (p) => p.github?.commits_12mo, align: "right" },
  top1: {
    key: "top1",
    header: "top1%",
    get: (p) => {
      const v = p.github?.top_committer_commit_share_12mo;
      return v != null ? Math.round(v * 100) : null;
    },
    align: "right",
  },
  top3: {
    key: "top3",
    header: "top3%",
    get: (p) => {
      const v = p.github?.top3_committer_commit_share_12mo;
      return v != null ? Math.round(v * 100) : null;
    },
    align: "right",
  },

  releases_12: { key: "releases_12", header: "rel/12m", get: (p) => p.npm?.releases_12mo, align: "right" },
  majors_24: { key: "majors_24", header: "maj/24m", get: (p) => p.npm?.major_bumps_24mo, align: "right" },

  dl_wk: { key: "dl_wk", header: "dl/wk", get: (p) => p.npm?.weekly_downloads, align: "right" },
  dep_pkgs: { key: "dep_pkgs", header: "dep-pkgs", get: (p) => p.ecosystems?.dependent_packages_count, align: "right" },
  dep_repos: { key: "dep_repos", header: "dep-repos", get: (p) => p.ecosystems?.dependent_repos_count, align: "right" },

  scorecard: { key: "scorecard", header: "score", get: (p) => p.depsdev?.scorecard_overall, align: "right" },
  maintained: { key: "maintained", header: "maint-sc", get: (p) => p.depsdev?.scorecard_maintained, align: "right" },

  cves_total: { key: "cves_total", header: "cve-tot", get: (p) => p.osv?.advisories_total, align: "right" },
  cves_unpatched: { key: "cves_unpatched", header: "cve-unp", get: (p) => p.osv?.unpatched_open_advisories, align: "right" },

  archived: { key: "archived", header: "arch", get: (p) => (p.github?.repo_archived ? "Y" : "") },
  deprecated: { key: "deprecated", header: "dep", get: (p) => (p.npm?.deprecated ? "Y" : "") },

  open_issues: { key: "open_issues", header: "issues", get: (p) => p.github?.open_issues, align: "right" },
  oldest_issue: { key: "oldest_issue", header: "oldest-d", get: (p) => p.github?.oldest_open_issue_age_days, align: "right" },

  cons_opened: { key: "cons_opened", header: "c-opened", get: (p) => p.responsiveness?.consumer_issues_opened_12mo, align: "right" },
  cons_no_resp: { key: "cons_no_resp", header: "no-resp", get: (p) => p.responsiveness?.consumer_issues_no_response_12mo, align: "right" },
  cons_resolved: { key: "cons_resolved", header: "resolved", get: (p) => p.responsiveness?.consumer_issues_resolved_12mo, align: "right" },
  first_resp_h: {
    key: "first_resp_h",
    header: "first-resp-h",
    get: (p) => {
      const v = p.responsiveness?.median_first_maintainer_response_hours_12mo;
      return v != null ? Math.round(v) : null;
    },
    align: "right",
  },
  p90_resp_h: {
    key: "p90_resp_h",
    header: "p90-resp-h",
    get: (p) => {
      const v = p.responsiveness?.p90_first_maintainer_response_hours_12mo;
      return v != null ? Math.round(v) : null;
    },
    align: "right",
  },
  awaiting: {
    key: "awaiting",
    header: "awaiting",
    get: (p) => p.responsiveness?.issues_still_awaiting_first_response,
    align: "right",
  },
};

const DEFAULT_COLUMNS = [
  "name",
  "direct",
  "depth",
  "maintainers",
  "committers",
  "top1",
  "publish_days",
  "commit_days",
  "releases_12",
  "scorecard",
  "cves_total",
  "cves_unpatched",
  "dep_pkgs",
  "cons_no_resp",
  "cons_resolved",
  "first_resp_h",
];

const columnKeys = values.columns ? values.columns.split(",").map((s) => s.trim()) : DEFAULT_COLUMNS;
const columns = columnKeys.map((k) => {
  const c = ALL_COLUMNS[k];
  if (!c) throw new Error(`Unknown column: ${k}. Available: ${Object.keys(ALL_COLUMNS).join(", ")}`);
  return c;
});

let packages = data.packages;
if (directOnly) packages = packages.filter((p) => p.direct);

if (values.sort) {
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
