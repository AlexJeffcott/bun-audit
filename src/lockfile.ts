import type { PackageRef } from "./types.ts";

type LockEntry = [string] | [string, string, Record<string, unknown>?, string?];

type Lockfile = {
  lockfileVersion: number;
  workspaces?: Record<string, {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>;
  catalog?: Record<string, string>;
  packages: Record<string, LockEntry>;
};

function stripJsonc(text: string): string {
  // bun.lock is JSON with trailing commas. Strip them only when followed by } or ]
  // and not inside strings. Simple state machine.
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && ch === ",") {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\n" || text[j] === "\t" || text[j] === "\r")) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function parseSpec(spec: string): { name: string; version: string } | null {
  // "@scope/name@1.2.3" or "name@1.2.3" or "@scope/name@workspace:path"
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return { name, version };
}

function isWorkspaceVersion(v: string): boolean {
  return v.startsWith("workspace:") || v.startsWith("link:") || v.startsWith("file:");
}

export type ParsedLockfile = {
  packages: PackageRef[];
  catalog: Record<string, string>;
  rootWorkspaceName: string;
};

export async function parseLockfile(path: string): Promise<ParsedLockfile> {
  const raw = await Bun.file(path).text();
  const lock = JSON.parse(stripJsonc(raw)) as Lockfile;

  const catalog = lock.catalog ?? {};
  const workspaces = lock.workspaces ?? {};
  const rootWorkspace = workspaces[""];
  const rootName = rootWorkspace?.name ?? "root";

  // Collect direct deps from all workspaces. A dep that appears in any workspace
  // package.json counts as "direct" for the project; transitive ones come from
  // the resolved packages section.
  const directNames = new Set<string>();
  const workspaceNames = new Set<string>();
  for (const [wsKey, ws] of Object.entries(workspaces)) {
    if (ws.name) workspaceNames.add(ws.name);
    const deps = {
      ...(ws.dependencies ?? {}),
      ...(ws.devDependencies ?? {}),
      ...(ws.peerDependencies ?? {}),
      ...(ws.optionalDependencies ?? {}),
    };
    for (const dn of Object.keys(deps)) directNames.add(dn);
  }

  // Build importer counts: for each package in `packages`, count how many other
  // packages (or workspaces) declare it as a dep.
  const importerCounts = new Map<string, number>();
  const bump = (n: string) => importerCounts.set(n, (importerCounts.get(n) ?? 0) + 1);
  for (const ws of Object.values(workspaces)) {
    const deps = {
      ...(ws.dependencies ?? {}),
      ...(ws.devDependencies ?? {}),
    };
    for (const dn of Object.keys(deps)) bump(dn);
  }
  for (const [, entry] of Object.entries(lock.packages)) {
    if (entry.length < 3) continue;
    const depsObj = entry[2] as Record<string, unknown> | undefined;
    if (!depsObj) continue;
    const deps = (depsObj.dependencies ?? {}) as Record<string, string>;
    const peerDeps = (depsObj.peerDependencies ?? {}) as Record<string, string>;
    for (const dn of Object.keys(deps)) bump(dn);
    for (const dn of Object.keys(peerDeps)) bump(dn);
  }

  const out: PackageRef[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of Object.entries(lock.packages)) {
    const spec = entry[0];
    const parsed = parseSpec(spec);
    if (!parsed) continue;
    const { name, version } = parsed;

    const isWs = workspaceNames.has(name) || isWorkspaceVersion(version);
    if (isWs) continue; // skip workspace packages

    const dedupeKey = `${name}@${version}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const depsObj = (entry[2] as Record<string, unknown> | undefined) ?? {};
    const declared = {
      ...((depsObj.dependencies ?? {}) as Record<string, string>),
    };
    const declaredCount = Object.keys(declared).length;

    out.push({
      name,
      version,
      direct: directNames.has(name),
      depth: 0, // populated below
      importers_in_tree: importerCounts.get(name) ?? 0,
      declared_deps_count: declaredCount,
      is_workspace: false,
    });
  }

  // Depth: BFS from direct deps using the dependency graph implied by `packages`.
  const byName = new Map<string, PackageRef>();
  for (const p of out) byName.set(p.name, p);

  const childrenOf = new Map<string, Set<string>>();
  for (const [, entry] of Object.entries(lock.packages)) {
    const spec = entry[0];
    const parsed = parseSpec(spec);
    if (!parsed) continue;
    if (entry.length < 3) continue;
    const depsObj = entry[2] as Record<string, unknown> | undefined;
    if (!depsObj) continue;
    const deps = (depsObj.dependencies ?? {}) as Record<string, string>;
    const set = childrenOf.get(parsed.name) ?? new Set<string>();
    for (const dn of Object.keys(deps)) set.add(dn);
    childrenOf.set(parsed.name, set);
  }

  const queue: Array<{ name: string; depth: number }> = [];
  const depthOf = new Map<string, number>();
  for (const p of out) {
    if (p.direct) {
      queue.push({ name: p.name, depth: 1 });
      depthOf.set(p.name, 1);
    }
  }
  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    const children = childrenOf.get(name);
    if (!children) continue;
    for (const cn of children) {
      const prev = depthOf.get(cn) ?? Infinity;
      const next = depth + 1;
      if (next < prev) {
        depthOf.set(cn, next);
        queue.push({ name: cn, depth: next });
      }
    }
  }

  for (const p of out) {
    p.depth = depthOf.get(p.name) ?? 0;
  }

  return { packages: out, catalog, rootWorkspaceName: rootName };
}
