import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = new URL("../.cache/", import.meta.url).pathname;

// Stored wrapper: {_cached_at: epochMs, v: <payload>}. The timestamp lives in
// the file content rather than filesystem mtime so that TTL survives git
// checkout (where mtimes reset to clone time).
type CacheEntry<T> = { _cached_at: number; v: T };

export class Cache {
  constructor(private namespace: string, private ttlMs: number) {
    const dir = join(CACHE_DIR, namespace);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private pathFor(key: string): string {
    const safe = key.replaceAll("/", "__").replaceAll(":", "_");
    return join(CACHE_DIR, this.namespace, `${safe}.json`);
  }

  async get<T>(key: string): Promise<T | null> {
    const path = this.pathFor(key);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    try {
      const parsed = (await file.json()) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const entry = parsed as Partial<CacheEntry<T>>;
      if (typeof entry._cached_at !== "number" || !("v" in entry)) return null;
      if (Date.now() - entry._cached_at > this.ttlMs) return null;
      return entry.v as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const path = this.pathFor(key);
    const wrapper: CacheEntry<T> = { _cached_at: Date.now(), v: value };
    await Bun.write(path, JSON.stringify(wrapper));
  }
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
