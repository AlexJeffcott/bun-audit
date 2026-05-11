import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const GH_URL = /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?/]|$)/i;

export type ResolvedInput = {
  lockfilePath: string;
  label: string;
  source: "lockfile" | "directory" | "github-clone";
  cleanupTmp?: string;
};

export async function resolveInput(input: string): Promise<ResolvedInput> {
  // GitHub URL
  const gh = input.match(GH_URL);
  if (gh) {
    const owner = gh[1];
    const repo = gh[2];
    const dest = join(tmpdir(), "bun-audit-clones", `${owner}__${repo}-${Date.now()}`);
    const cleanUrl = `https://github.com/${owner}/${repo}.git`;
    console.error(`[bun-audit] cloning ${cleanUrl} (shallow) -> ${dest}`);
    const proc = Bun.spawn(["git", "clone", "--depth", "1", "--quiet", cleanUrl, dest], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git clone failed with exit code ${code}`);
    const lock = join(dest, "bun.lock");
    if (!existsSync(lock)) throw new Error(`No bun.lock found at the root of ${owner}/${repo}`);
    return { lockfilePath: lock, label: `${owner}/${repo}`, source: "github-clone", cleanupTmp: dest };
  }

  // Local path
  if (!existsSync(input)) throw new Error(`Path does not exist: ${input}`);
  const stat = statSync(input);
  if (stat.isDirectory()) {
    const lock = join(input, "bun.lock");
    if (!existsSync(lock)) throw new Error(`No bun.lock found in directory: ${input}`);
    return { lockfilePath: lock, label: input, source: "directory" };
  }
  if (stat.isFile()) {
    return { lockfilePath: input, label: input, source: "lockfile" };
  }
  throw new Error(`Cannot resolve input: ${input}`);
}
