# bun-audit

Reads a `bun.lock` and emits one JSON record per resolved package, plus a project rollup, drawn from six external sources. The output is raw observable signals: counts, timestamps, measured durations, and externally-published scores. No composite or invented risk number is computed by this script.

## Usage

```sh
# Audit a project by directory
bun src/index.ts ~/projects/lingua

# Audit by GitHub URL (shallow-clones into /tmp first)
bun src/index.ts https://github.com/owner/repo

# Audit a specific bun.lock file
bun src/index.ts /path/to/bun.lock

# Render a table from the JSON output
bun src/report.ts --in audit.json --direct-only --sort committers
```

The positional argument accepts:

- a GitHub URL (`https://github.com/owner/repo` or `git@github.com:owner/repo`),
- a project directory containing `bun.lock`,
- or a direct path to a `bun.lock`.

Options:

- `--out <path>` — output JSON path (default `audit.json`)
- `--concurrency N` — parallel workers (default 4)
- `--limit N` — cap to N packages (debugging)
- `--direct-only` — skip transitive dependencies
- `--only a,b,c` — only audit these package names
- `--lockfile <path>` — explicit lockfile path, overrides the positional
- `-h`, `--help` — show usage

A GitHub token is read from `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`.

A disk cache lives in `./.cache/` and is tracked in version control so re-runs on a fresh clone benefit from previously-fetched data. Each cache file embeds its own `_cached_at` timestamp, so freshness survives `git checkout` (which would otherwise reset filesystem mtimes). Immutable per-version data is cached for 7 days; mutable per-package data for 24 hours.

Run `bun scripts/migrate-cache.ts` if you have older cache files and want to roll them into the current wrapped format.

## Sources

| Source | Fields it supplies |
| --- | --- |
| `registry.npmjs.org` | maintainers, version `time` map, declared deps, repository URL, deprecated flag, provenance, license, full release history (releases per 12mo, major bumps per 24mo, mean days between releases) |
| `api.npmjs.org/downloads` | weekly downloads |
| `api.deps.dev` | OpenSSF Scorecard overall + sub-scores (Maintained, Code-Review, Contributors, Dependency-Update-Tool) when published upstream |
| `packages.ecosyste.ms` | dependent packages and dependent repos counts, monthly downloads |
| `api.osv.dev` | advisory totals, advisories in last 12mo, advisories where the resolved version is still in an affected range |
| `api.github.com` (GraphQL + Search) | archived flag, owner type, default branch, last commit date, CI status, releases total, open/closed issue and PR counts, oldest open issue age, merged PRs in last 12mo, distinct committers and total commits in last 12mo, top-1 and top-3 committer commit share, discussions enabled |
| `api.github.com` (Issues timeline) | consumer issue buckets for the last 12mo: no response, bot-only response, acknowledged then silent, stale-bot closed, closed without engagement, closed not planned, triaged stalled, resolved. Median and p90 hours to first maintainer reply. Issues still awaiting first response and the oldest such age. |

## Output shape

Per-package record fields are grouped under named source objects (`npm`, `depsdev`, `github`, `responsiveness`, `osv`, `ecosystems`). Each source carries `_source` and `_fetched_at` siblings. Missing data is `null`, never imputed. Errors per source are surfaced in the package's `errors` array.

A `commits_12mo_truncated: true` flag means the GitHub commit history exceeded the page cap (1000 commits / 10 pages). For such repos, committer counts are a lower bound.

## What this script does not do

- No composite risk score.
- No weighted percentages.
- No traffic-light colours or pass/fail verdicts.

Analysis on top of the raw output is a separate step. The signals can be aggregated, filtered, and weighted however the analyst chooses.

## Heuristic thresholds (responsiveness only)

Three thresholds in `src/sources/responsiveness.ts` are gut-feel:

- `GUT_FEEL_ACK_THEN_SILENT_DAYS = 90`
- `GUT_FEEL_STALE_BOT_QUIET_WINDOW_DAYS = 30`
- `GUT_FEEL_TRIAGED_STALLED_DAYS = 90`

These decide bucket boundaries inside the responsiveness classifier. Every bucket is still derived from observable timeline events; the thresholds only control which observable label gets assigned.

## Rate limits and pacing

- GitHub Search is capped at 30/min for authenticated requests. The script throttles search to one call every 2.5 seconds, serialised globally across workers.
- GitHub GraphQL is rate-limited by points/hour, not requests/hour. The current query set stays well under the cap.
- npm registry, deps.dev, ecosyste.ms, and OSV impose no published per-user limits relevant at this scale.

Expect roughly one minute per ten packages on a cold cache. Re-runs against the same lockfile are near-instant.
