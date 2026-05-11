import { Cache, DAY } from "../cache.ts";
import type { NpmSignals, Sourced } from "../types.ts";

const registryCache = new Cache("npm-registry", DAY);
const downloadsCache = new Cache("npm-downloads", DAY);

// Full registry document — the wire shape from registry.npmjs.org. We never
// cache this directly; we slim it before writing to disk.
type RegistryDoc = {
  name: string;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, RegistryVersionEntry>;
  time?: Record<string, string>;
  maintainers?: Array<{ name: string; email?: string }>;
  repository?: { type?: string; url?: string } | string;
  license?: string;
  deprecated?: string;
};

type RegistryVersionEntry = {
  deprecated?: string;
  repository?: { type?: string; url?: string } | string;
  license?: string;
  dist?: { attestations?: unknown };
  // Many other fields exist (description, scripts, dependencies, types, etc.)
  // but the audit doesn't read them, so they are dropped before caching.
};

// Slim shape that lands on disk. The full versions map is replaced by the
// minimal per-version metadata we actually consume.
type RegistryDocSlim = {
  name: string;
  maintainer_names: string[];
  repository_url: string | null;
  license: string | null;
  deprecated: string | null;
  time: Record<string, string>;
  versions_meta: Record<string, RegistryVersionEntry>;
};

function slimRegistryDoc(doc: RegistryDoc): RegistryDocSlim {
  const versions_meta: Record<string, RegistryVersionEntry> = {};
  const fullVersions = doc.versions ?? {};
  for (const [v, meta] of Object.entries(fullVersions)) {
    // Keep only the per-version fields the audit consumes.
    const slim: RegistryVersionEntry = {};
    if (meta.deprecated) slim.deprecated = meta.deprecated;
    if (meta.repository) slim.repository = meta.repository;
    if (typeof meta.license === "string") slim.license = meta.license;
    if (meta.dist && (meta.dist as { attestations?: unknown }).attestations) {
      slim.dist = { attestations: true };
    }
    versions_meta[v] = slim;
  }
  const repoTop = typeof doc.repository === "string" ? doc.repository : (doc.repository?.url ?? null);
  return {
    name: doc.name,
    maintainer_names: (doc.maintainers ?? []).map((m) => m.name),
    repository_url: repoTop,
    license: typeof doc.license === "string" ? doc.license : null,
    deprecated: doc.deprecated ?? null,
    time: doc.time ?? {},
    versions_meta,
  };
}

function parseRepoUrl(repo: unknown): { url: string; owner: string | null; repo: string | null } | null {
  if (!repo) return null;
  const url = typeof repo === "string" ? repo : (repo as { url?: string }).url;
  if (!url) return null;
  // git+https://github.com/owner/repo.git, https://github.com/owner/repo, git@github.com:owner/repo.git
  // Match owner and repo. Repo name may contain dots (protobuf.js).
  // Trailing may be: .git, #branch, /tree/path, ?query, or end-of-string.
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?/]|$)/i);
  if (m) return { url, owner: m[1], repo: m[2] };
  return { url, owner: null, repo: null };
}

function semverParts(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function releaseClass(prev: [number, number, number], curr: [number, number, number]): "major" | "minor" | "patch" | null {
  if (curr[0] > prev[0]) return "major";
  if (curr[0] < prev[0]) return null;
  if (curr[1] > prev[1]) return "minor";
  if (curr[1] < prev[1]) return null;
  if (curr[2] > prev[2]) return "patch";
  return null;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / DAY;
}

async function fetchRegistry(name: string): Promise<RegistryDocSlim | null> {
  const cached = await registryCache.get<RegistryDocSlim>(name);
  if (cached) return cached;
  const url = `https://registry.npmjs.org/${name}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const full = (await res.json()) as RegistryDoc;
  const slim = slimRegistryDoc(full);
  await registryCache.set(name, slim);
  return slim;
}

async function fetchWeeklyDownloads(name: string): Promise<number | null> {
  const cached = await downloadsCache.get<{ downloads: number }>(name);
  if (cached) return cached.downloads;
  const url = `https://api.npmjs.org/downloads/point/last-week/${name}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { downloads?: number };
  if (typeof data.downloads !== "number") return null;
  await downloadsCache.set(name, { downloads: data.downloads });
  return data.downloads;
}

export async function fetchNpmSignals(name: string, version: string): Promise<Sourced<NpmSignals> | null> {
  const doc = await fetchRegistry(name);
  if (!doc) return null;

  const time = doc.time;
  const versionsObj = doc.versions_meta;
  const versionEntries = Object.keys(versionsObj)
    .map((v) => ({ v, t: time[v] }))
    .filter((e) => typeof e.t === "string")
    .map((e) => ({ v: e.v, parts: semverParts(e.v), date: new Date(e.t!) }))
    .filter((e) => e.parts !== null && !Number.isNaN(e.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime()) as Array<{ v: string; parts: [number, number, number]; date: Date }>;

  const now = new Date();
  const cutoff12 = new Date(now.getTime() - 365 * DAY);
  const cutoff24 = new Date(now.getTime() - 730 * DAY);

  const latest = versionEntries.length > 0 ? versionEntries[versionEntries.length - 1] : null;
  const versionTime = time[version] ? new Date(time[version]) : null;

  let releases12 = 0;
  let majors12 = 0;
  let minors12 = 0;
  let patches12 = 0;
  let majorBumps24 = 0;
  const releaseDates12: Date[] = [];
  const majorBumpDates24: Date[] = [];

  for (let i = 1; i < versionEntries.length; i++) {
    const prev = versionEntries[i - 1];
    const curr = versionEntries[i];
    const cls = releaseClass(prev.parts, curr.parts);
    if (!cls) continue;
    if (curr.date >= cutoff12) {
      releases12++;
      releaseDates12.push(curr.date);
      if (cls === "major") majors12++;
      else if (cls === "minor") minors12++;
      else patches12++;
    }
    if (curr.date >= cutoff24 && cls === "major") {
      majorBumps24++;
      majorBumpDates24.push(curr.date);
    }
  }

  const meanGap = (dates: Date[]) => {
    if (dates.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < dates.length; i++) sum += daysBetween(dates[i - 1], dates[i]);
    return sum / (dates.length - 1);
  };

  const versionMeta = versionsObj[version] ?? {};
  const repoFromVersion = parseRepoUrl(versionMeta.repository) ?? parseRepoUrl(doc.repository_url);
  const hasProvenance = Boolean(versionMeta.dist && (versionMeta.dist as { attestations?: unknown }).attestations);

  return {
    _source: "registry.npmjs.org",
    _fetched_at: new Date().toISOString(),
    latest_publish_iso: latest ? latest.date.toISOString() : null,
    days_since_latest_publish: latest ? Math.floor((now.getTime() - latest.date.getTime()) / DAY) : null,
    version_publish_iso: versionTime ? versionTime.toISOString() : null,
    npm_maintainers_count: doc.maintainer_names.length,
    npm_maintainers: doc.maintainer_names,
    weekly_downloads: await fetchWeeklyDownloads(name),
    repository_url: repoFromVersion?.url ?? null,
    repository_owner: repoFromVersion?.owner ?? null,
    repository_repo: repoFromVersion?.repo ?? null,
    has_provenance: hasProvenance,
    license: (typeof versionMeta.license === "string" ? versionMeta.license : null) ?? doc.license,
    deprecated: versionMeta.deprecated ?? doc.deprecated ?? null,
    versions_total: versionEntries.length,
    releases_12mo: releases12,
    major_bumps_24mo: majorBumps24,
    patch_releases_12mo: patches12,
    minor_releases_12mo: minors12,
    major_releases_12mo: majors12,
    mean_days_between_releases_12mo: meanGap(releaseDates12),
    mean_days_between_major_bumps_24mo: meanGap(majorBumpDates24),
  };
}
