import { Cache, DAY } from "../cache.ts";

const cache = new Cache("ecosystems", DAY);

export type EcosystemsSignals = {
  _source: string;
  _fetched_at: string;
  dependent_packages_count: number | null;
  dependent_repos_count: number | null;
  monthly_downloads: number | null;
  versions_count: number | null;
  average_release_frequency_days: number | null;
};

type EcosystemsPkg = {
  name?: string;
  latest_release_published_at?: string;
  downloads?: number;
  downloads_period?: string;
  dependent_packages_count?: number;
  dependent_repos_count?: number;
  average_release_frequency?: string | null;
  versions_count?: number;
};

function parseFrequency(f: string | null | undefined): number | null {
  if (!f) return null;
  // ecosyste.ms returns ISO 8601 durations like "PT72H" or "P3D"
  const m = f.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/);
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  return days + hours / 24;
}

export async function fetchEcosystemsSignals(name: string): Promise<EcosystemsSignals | null> {
  const cached = await cache.get<EcosystemsPkg>(name);
  let data = cached;
  if (!data) {
    const encoded = encodeURIComponent(name);
    const res = await fetch(`https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encoded}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    data = (await res.json()) as EcosystemsPkg;
    await cache.set(name, data);
  }
  return {
    _source: "packages.ecosyste.ms",
    _fetched_at: new Date().toISOString(),
    dependent_packages_count: data.dependent_packages_count ?? null,
    dependent_repos_count: data.dependent_repos_count ?? null,
    monthly_downloads: data.downloads_period === "last-month" ? (data.downloads ?? null) : null,
    versions_count: data.versions_count ?? null,
    average_release_frequency_days: parseFrequency(data.average_release_frequency ?? null),
  };
}
