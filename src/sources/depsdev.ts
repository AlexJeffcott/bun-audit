import { Cache, DAY } from "../cache.ts";
import type { DepsDevSignals, Sourced } from "../types.ts";

// deps.dev caches per-version data; the cache TTL is long because the data
// is keyed to an immutable version. Scorecard does refresh upstream, so we
// still re-fetch weekly.
const cache = new Cache("depsdev", 7 * DAY);

type DepsDevVersion = {
  versionKey: { system: string; name: string; version: string };
  licenses?: string[];
  publishedAt?: string;
  isDefault?: boolean;
  relatedProjects?: Array<{
    projectKey: { id: string };
    relationProvenance?: string;
    relationType?: string;
  }>;
};

type DepsDevProject = {
  projectKey: { id: string };
  openIssuesCount?: number;
  starsCount?: number;
  forksCount?: number;
  license?: string;
  description?: string;
  homepage?: string;
  scorecard?: {
    date?: string;
    overallScore?: number;
    checks?: Array<{ name: string; score: number; reason?: string }>;
  };
};

async function fetchVersion(name: string, version: string): Promise<DepsDevVersion | null> {
  const key = `${name}@${version}`;
  const cached = await cache.get<DepsDevVersion>(`version_${key}`);
  if (cached) return cached;
  const encoded = encodeURIComponent(name);
  const url = `https://api.deps.dev/v3/systems/npm/packages/${encoded}/versions/${encodeURIComponent(version)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as DepsDevVersion;
  await cache.set(`version_${key}`, data);
  return data;
}

async function fetchProject(projectId: string): Promise<DepsDevProject | null> {
  const cached = await cache.get<DepsDevProject>(`project_${projectId}`);
  if (cached) return cached;
  const url = `https://api.deps.dev/v3/projects/${encodeURIComponent(projectId)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as DepsDevProject;
  await cache.set(`project_${projectId}`, data);
  return data;
}

function findCheck(scorecard: DepsDevProject["scorecard"], name: string): number | null {
  if (!scorecard?.checks) return null;
  const c = scorecard.checks.find((c) => c.name === name);
  return c?.score ?? null;
}

export async function fetchDepsDevSignals(name: string, version: string): Promise<Sourced<DepsDevSignals> | null> {
  const versionDoc = await fetchVersion(name, version);
  if (!versionDoc) return null;

  // Find GitHub source project from relatedProjects
  const ghProject = versionDoc.relatedProjects?.find(
    (p) => p.projectKey.id.startsWith("github.com/") && (p.relationType === "SOURCE_REPO_TYPE" || p.relationType === "SOURCE_REPO" || !p.relationType),
  );
  const project = ghProject ? await fetchProject(ghProject.projectKey.id) : null;

  return {
    _source: "api.deps.dev",
    _fetched_at: new Date().toISOString(),
    scorecard_overall: project?.scorecard?.overallScore ?? null,
    scorecard_maintained: findCheck(project?.scorecard, "Maintained"),
    scorecard_code_review: findCheck(project?.scorecard, "Code-Review"),
    scorecard_contributors: findCheck(project?.scorecard, "Contributors"),
    scorecard_dependency_update_tool: findCheck(project?.scorecard, "Dependency-Update-Tool"),
    scorecard_checked_at: project?.scorecard?.date ?? null,
    dependents_count: null,
  };
}
