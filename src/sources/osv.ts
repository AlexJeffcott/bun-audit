import { Cache, DAY } from "../cache.ts";
import type { OsvSignals, Sourced } from "../types.ts";

const cache = new Cache("osv", DAY);

type OsvEvent = { introduced?: string; fixed?: string; last_affected?: string; limit?: string };

type OsvAffected = {
  package?: { name?: string; ecosystem?: string };
  ranges?: Array<{ type?: string; events?: OsvEvent[] }>;
  versions?: string[];
};

type OsvVuln = {
  id: string;
  published?: string;
  modified?: string;
  withdrawn?: string;
  affected?: OsvAffected[];
};

type OsvQueryResponse = { vulns?: OsvVuln[] };

function semverCmp(a: string, b: string): number {
  const pa = a.match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = b.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const da = Number(pa[i]);
    const db = Number(pb[i]);
    if (da !== db) return da - db;
  }
  return 0;
}

function versionAffected(version: string, affected: OsvAffected[] | undefined, pkgName: string): boolean {
  if (!affected) return false;
  for (const a of affected) {
    if (a.package?.ecosystem && a.package.ecosystem !== "npm") continue;
    if (a.package?.name && a.package.name !== pkgName) continue;
    if (a.versions && a.versions.includes(version)) return true;
    for (const r of a.ranges ?? []) {
      if (r.type !== "SEMVER" && r.type !== "ECOSYSTEM") continue;
      let introduced: string | null = null;
      let fixed: string | null = null;
      let lastAffected: string | null = null;
      for (const ev of r.events ?? []) {
        if (ev.introduced) introduced = ev.introduced;
        if (ev.fixed) fixed = ev.fixed;
        if (ev.last_affected) lastAffected = ev.last_affected;
      }
      const introOk = !introduced || introduced === "0" || semverCmp(version, introduced) >= 0;
      const fixedOk = fixed ? semverCmp(version, fixed) < 0 : true;
      const lastOk = lastAffected ? semverCmp(version, lastAffected) <= 0 : true;
      if (introOk && fixedOk && lastOk) {
        if (fixed || lastAffected || introduced) return true;
      }
    }
  }
  return false;
}

async function queryOsv(name: string): Promise<OsvVuln[]> {
  const cached = await cache.get<{ vulns: OsvVuln[] }>(name);
  if (cached) return cached.vulns;
  const res = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: "npm" } }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as OsvQueryResponse;
  const vulns = data.vulns ?? [];
  await cache.set(name, { vulns });
  return vulns;
}

export async function fetchOsvSignals(name: string, version: string): Promise<Sourced<OsvSignals> | null> {
  const vulns = await queryOsv(name);
  const now = Date.now();
  const cutoff12 = now - 365 * DAY;

  let total = 0;
  let last12 = 0;
  let unpatched = 0;
  const ids: string[] = [];

  for (const v of vulns) {
    if (v.withdrawn) continue;
    total++;
    ids.push(v.id);
    if (v.published) {
      const t = new Date(v.published).getTime();
      if (!Number.isNaN(t) && t >= cutoff12) last12++;
    }
    if (versionAffected(version, v.affected, name)) unpatched++;
  }

  return {
    _source: "api.osv.dev",
    _fetched_at: new Date().toISOString(),
    advisories_total: total,
    advisories_12mo: last12,
    unpatched_open_advisories: unpatched,
    mean_days_advisory_to_patched_release_24mo: null, // deferred
    advisory_ids: ids,
  };
}
