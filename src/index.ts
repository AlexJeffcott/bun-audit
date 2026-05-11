import { parseArgs } from "node:util";
import { parseLockfile } from "./lockfile.ts";
import { composeRecord, rollup } from "./compose.ts";
import { resolveInput } from "./resolve-input.ts";
import type { PackageRecord } from "./types.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    lockfile: { type: "string" },
    out: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string" },
    only: { type: "string" },
    "direct-only": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.error(`usage: bun-audit [<input>] [options]

input (positional, optional):
  <github-url>      e.g. https://github.com/owner/repo — shallow-clones first
  <directory>       directory containing bun.lock
  <lockfile-path>   direct path to a bun.lock
  (omitted)         defaults to bun.lock in CWD when --lockfile not set

options:
  --lockfile <path>    explicit lockfile path (overrides positional)
  --out <path>         output JSON path (default: audit.json)
  --concurrency N      parallel workers (default: 4)
  --limit N            cap to N packages (debugging)
  --only a,b,c         only audit these package names
  --direct-only        skip transitive dependencies
  -h, --help           show this message
`);
  process.exit(0);
}

const input = positionals[0];
const resolved = values.lockfile
  ? { lockfilePath: values.lockfile, label: values.lockfile, source: "lockfile" as const }
  : input
    ? await resolveInput(input)
    : { lockfilePath: "bun.lock", label: "bun.lock", source: "lockfile" as const };

const lockfilePath = resolved.lockfilePath;
const outPath = values.out ?? "audit.json";
const limit = values.limit ? Number(values.limit) : Infinity;
const concurrency = values.concurrency ? Number(values.concurrency) : 4;
const directOnly = values["direct-only"] === true;
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;

console.error(`[bun-audit] target: ${resolved.label} (${resolved.source})`);
console.error(`[bun-audit] reading ${lockfilePath}`);
const parsed = await parseLockfile(lockfilePath);
console.error(`[bun-audit] ${parsed.packages.length} non-workspace packages`);

let packages = parsed.packages;
if (directOnly) packages = packages.filter((p) => p.direct);
if (only) packages = packages.filter((p) => only.has(p.name));
if (Number.isFinite(limit)) packages = packages.slice(0, limit);
console.error(`[bun-audit] enriching ${packages.length} packages (concurrency=${concurrency})`);

const records: PackageRecord[] = [];
let done = 0;
let idx = 0;

async function worker() {
  while (idx < packages.length) {
    const myIdx = idx++;
    const p = packages[myIdx];
    const t0 = Date.now();
    try {
      const rec = await composeRecord(p);
      records[myIdx] = rec;
    } catch (e) {
      records[myIdx] = {
        ...p,
        npm: null,
        depsdev: null,
        github: null,
        responsiveness: null,
        osv: null,
        errors: [`compose failed: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
    done++;
    const ms = Date.now() - t0;
    if (done % 5 === 0 || done === packages.length) {
      console.error(`[bun-audit] ${done}/${packages.length} (last: ${p.name} ${ms}ms)`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const project = rollup(lockfilePath, records);

const output = {
  project,
  packages: records,
};

await Bun.write(outPath, JSON.stringify(output, null, 2));
console.error(`[bun-audit] wrote ${outPath}`);
