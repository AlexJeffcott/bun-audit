import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = new URL("../.cache/", import.meta.url).pathname;

type AnyJson = Record<string, unknown>;

function isAlreadyWrapped(v: unknown): v is { _cached_at: number; v: unknown } {
  return !!v && typeof v === "object" && typeof (v as AnyJson)._cached_at === "number" && "v" in (v as AnyJson);
}

const ECOSYSTEMS_KEEP = new Set([
  "name", "latest_release_published_at", "downloads", "downloads_period",
  "dependent_packages_count", "dependent_repos_count", "average_release_frequency", "versions_count",
]);

function slimEcosystems(doc: AnyJson): AnyJson {
  const out: AnyJson = {};
  for (const k of ECOSYSTEMS_KEEP) if (k in doc) out[k] = doc[k];
  return out;
}

function slimNpmRegistry(doc: AnyJson): AnyJson {
  const versions_meta: Record<string, AnyJson> = {};
  const fullVersions = (doc.versions as Record<string, AnyJson>) ?? {};
  for (const [v, meta] of Object.entries(fullVersions)) {
    const slim: AnyJson = {};
    if (meta.deprecated) slim.deprecated = meta.deprecated;
    if (meta.repository) slim.repository = meta.repository;
    if (typeof meta.license === "string") slim.license = meta.license;
    if (meta.dist && (meta.dist as AnyJson).attestations) {
      slim.dist = { attestations: true };
    }
    versions_meta[v] = slim;
  }
  const repoTop = typeof doc.repository === "string"
    ? doc.repository
    : (doc.repository as AnyJson | undefined)?.url ?? null;
  return {
    name: doc.name,
    maintainer_names: ((doc.maintainers as Array<{ name: string }> | undefined) ?? []).map((m) => m.name),
    repository_url: repoTop,
    license: typeof doc.license === "string" ? doc.license : null,
    deprecated: doc.deprecated ?? null,
    time: doc.time ?? {},
    versions_meta,
  };
}

let migrated = 0;
let skipped = 0;
let slimmed = 0;
const namespaces = readdirSync(CACHE_DIR);
for (const ns of namespaces) {
  const nsDir = join(CACHE_DIR, ns);
  let files: string[];
  try {
    files = readdirSync(nsDir);
  } catch {
    continue;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const fp = join(nsDir, f);
    const text = await Bun.file(fp).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    let cachedAt: number;
    let payload: unknown;
    if (isAlreadyWrapped(parsed)) {
      cachedAt = parsed._cached_at;
      payload = parsed.v;
    } else {
      cachedAt = statSync(fp).mtimeMs;
      payload = parsed;
    }
    let didSlim = false;
    if (ns === "npm-registry" && payload && typeof payload === "object" && "versions" in (payload as AnyJson)) {
      payload = slimNpmRegistry(payload as AnyJson);
      didSlim = true;
    }
    if (ns === "ecosystems" && payload && typeof payload === "object" && "repo_metadata" in (payload as AnyJson)) {
      payload = slimEcosystems(payload as AnyJson);
      didSlim = true;
    }
    if (isAlreadyWrapped(parsed) && !didSlim) {
      skipped++;
      continue;
    }
    if (didSlim) slimmed++;
    const wrapper = { _cached_at: cachedAt, v: payload };
    await Bun.write(fp, JSON.stringify(wrapper));
    migrated++;
  }
}

console.log(`migrated: ${migrated}  (slimmed npm-registry: ${slimmed})  already-wrapped: ${skipped}`);
