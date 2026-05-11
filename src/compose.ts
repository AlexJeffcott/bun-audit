import type { PackageRecord, PackageRef, ProjectRollup } from "./types.ts";
import { fetchNpmSignals } from "./sources/npm.ts";
import { fetchDepsDevSignals } from "./sources/depsdev.ts";
import { fetchGithubSignals } from "./sources/github.ts";
import { fetchResponsivenessSignals } from "./sources/responsiveness.ts";
import { fetchOsvSignals } from "./sources/osv.ts";
import { fetchEcosystemsSignals } from "./sources/ecosystems.ts";

async function safe<T>(label: string, errs: string[], fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errs.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function composeRecord(ref: PackageRef): Promise<PackageRecord> {
  const errors: string[] = [];
  const npm = await safe("npm", errors, () => fetchNpmSignals(ref.name, ref.version, ref.lockfile_integrity));

  const owner = npm?.repository_owner ?? null;
  const repo = npm?.repository_repo ?? null;

  const [depsdev, osv, ecosystems, github] = await Promise.all([
    safe("depsdev", errors, () => fetchDepsDevSignals(ref.name, ref.version)),
    safe("osv", errors, () => fetchOsvSignals(ref.name, ref.version)),
    safe("ecosystems", errors, () => fetchEcosystemsSignals(ref.name)),
    owner && repo ? safe("github", errors, () => fetchGithubSignals(owner, repo)) : Promise.resolve(null),
  ]);

  const responsiveness =
    owner && repo
      ? await safe("responsiveness", errors, () => fetchResponsivenessSignals(owner, repo))
      : null;

  return { ...ref, npm, depsdev, github, responsiveness, osv, ecosystems, errors };
}

export function rollup(lockfilePath: string, records: PackageRecord[]): ProjectRollup {
  const uniquePackages = new Set(records.map((r) => r.name));
  const orgs = new Set<string>();
  const npmMaintainers = new Set<string>();
  let direct = 0;
  let transitive = 0;
  let noPublish12 = 0;
  let noCommit12 = 0;
  let solo12 = 0;
  let archived = 0;
  let withCves = 0;
  let deprecated = 0;
  let integrityMismatch = 0;
  let integrityUnverifiable = 0;

  for (const r of records) {
    if (r.direct) direct++;
    else transitive++;
    if (r.npm?.repository_owner) orgs.add(r.npm.repository_owner);
    for (const m of r.npm?.npm_maintainers ?? []) npmMaintainers.add(m);
    if (r.npm?.days_since_latest_publish !== null && r.npm?.days_since_latest_publish !== undefined && r.npm.days_since_latest_publish > 365) noPublish12++;
    if (r.github?.days_since_last_commit !== null && r.github?.days_since_last_commit !== undefined && r.github.days_since_last_commit > 365) noCommit12++;
    if (r.github?.committers_12mo === 1) solo12++;
    if (r.github?.repo_archived === true) archived++;
    if ((r.osv?.unpatched_open_advisories ?? 0) > 0) withCves++;
    if (r.npm?.deprecated) deprecated++;
    if (r.npm?.integrity_matches_lockfile === false) integrityMismatch++;
    if (r.npm?.integrity_matches_lockfile === null && r.lockfile_integrity !== null) integrityUnverifiable++;
  }

  return {
    lockfile_path: lockfilePath,
    generated_at: new Date().toISOString(),
    total_direct_deps: direct,
    total_transitive_deps: transitive,
    unique_packages: uniquePackages.size,
    unique_orgs: orgs.size,
    unique_npm_maintainers: npmMaintainers.size,
    packages_no_publish_12mo: noPublish12,
    packages_no_commit_12mo: noCommit12,
    packages_solo_committer_12mo: solo12,
    packages_archived: archived,
    packages_with_open_cves: withCves,
    packages_deprecated: deprecated,
    packages_integrity_mismatch: integrityMismatch,
    packages_integrity_unverifiable: integrityUnverifiable,
  };
}
