import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = new URL("../.cache/", import.meta.url).pathname;

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
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > this.ttlMs) return null;
    try {
      return (await file.json()) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const path = this.pathFor(key);
    await Bun.write(path, JSON.stringify(value));
  }
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
