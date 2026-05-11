export type PackageRef = {
  name: string;
  version: string;
  direct: boolean;
  depth: number;
  importers_in_tree: number;
  declared_deps_count: number;
  is_workspace: boolean;
};

export type Sourced<T> = T & { _source: string; _fetched_at: string };

export type NpmSignals = {
  latest_publish_iso: string | null;
  days_since_latest_publish: number | null;
  version_publish_iso: string | null;
  npm_maintainers_count: number | null;
  npm_maintainers: string[] | null;
  weekly_downloads: number | null;
  repository_url: string | null;
  repository_owner: string | null;
  repository_repo: string | null;
  has_provenance: boolean | null;
  license: string | null;
  deprecated: string | null;
  versions_total: number | null;
  releases_12mo: number | null;
  major_bumps_24mo: number | null;
  patch_releases_12mo: number | null;
  minor_releases_12mo: number | null;
  major_releases_12mo: number | null;
  mean_days_between_releases_12mo: number | null;
  mean_days_between_major_bumps_24mo: number | null;
};

export type DepsDevSignals = {
  scorecard_overall: number | null;
  scorecard_maintained: number | null;
  scorecard_code_review: number | null;
  scorecard_contributors: number | null;
  scorecard_dependency_update_tool: number | null;
  scorecard_checked_at: string | null;
  dependents_count: number | null;
};

export type GithubSignals = {
  repo_archived: boolean | null;
  owner_type: "User" | "Organization" | null;
  last_commit_iso: string | null;
  days_since_last_commit: number | null;
  default_branch: string | null;
  default_branch_last_ci_status: string | null;
  default_branch_last_ci_run_at: string | null;
  last_release_iso: string | null;
  releases_total: number | null;
  open_issues: number | null;
  closed_issues: number | null;
  open_prs: number | null;
  closed_prs: number | null;
  merged_prs_12mo: number | null;
  issues_closed_12mo: number | null;
  issues_opened_12mo: number | null;
  oldest_open_issue_age_days: number | null;
  committers_12mo: number | null;
  commits_12mo: number | null;
  commits_12mo_truncated: boolean;
  top_committer_commit_share_12mo: number | null;
  top3_committer_commit_share_12mo: number | null;
  has_discussions_enabled: boolean | null;
};

export type ResponsivenessSignals = {
  consumer_issues_opened_12mo: number | null;
  consumer_issues_no_response_12mo: number | null;
  consumer_issues_bot_only_response_12mo: number | null;
  consumer_issues_acknowledged_then_silent_12mo: number | null;
  consumer_issues_stale_bot_closed_12mo: number | null;
  consumer_issues_closed_without_engagement_12mo: number | null;
  consumer_issues_closed_not_planned_12mo: number | null;
  consumer_issues_triaged_stalled_12mo: number | null;
  consumer_issues_resolved_12mo: number | null;
  median_first_maintainer_response_hours_12mo: number | null;
  p90_first_maintainer_response_hours_12mo: number | null;
  issues_still_awaiting_first_response: number | null;
  oldest_awaiting_first_response_days: number | null;
};

export type OsvSignals = {
  advisories_total: number | null;
  advisories_12mo: number | null;
  unpatched_open_advisories: number | null;
  mean_days_advisory_to_patched_release_24mo: number | null;
  advisory_ids: string[] | null;
};

import type { EcosystemsSignals } from "./sources/ecosystems.ts";

export type PackageRecord = PackageRef & {
  npm: Sourced<NpmSignals> | null;
  depsdev: Sourced<DepsDevSignals> | null;
  github: Sourced<GithubSignals> | null;
  responsiveness: Sourced<ResponsivenessSignals> | null;
  osv: Sourced<OsvSignals> | null;
  ecosystems: EcosystemsSignals | null;
  errors: string[];
};

export type ProjectRollup = {
  lockfile_path: string;
  generated_at: string;
  total_direct_deps: number;
  total_transitive_deps: number;
  unique_packages: number;
  unique_orgs: number;
  unique_npm_maintainers: number;
  packages_no_publish_12mo: number;
  packages_no_commit_12mo: number;
  packages_solo_committer_12mo: number;
  packages_archived: number;
  packages_with_open_cves: number;
  packages_deprecated: number;
};
