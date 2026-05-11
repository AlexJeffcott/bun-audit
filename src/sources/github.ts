import { Cache, DAY } from "../cache.ts";
import type { GithubSignals, Sourced } from "../types.ts";

const cache = new Cache("github", DAY);

let cachedToken: string | null = null;
async function token(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  const envTok = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envTok) {
    cachedToken = envTok;
    return cachedToken;
  }
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    cachedToken = out || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

const GQL_REPO = `
query Repo($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    isArchived
    hasDiscussionsEnabled
    owner { __typename }
    defaultBranchRef {
      name
      target {
        ... on Commit {
          committedDate
          checkSuites(first: 5) {
            nodes { status conclusion updatedAt }
          }
          history(since: $since, first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              author { user { login } email name }
            }
          }
        }
      }
    }
    releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { publishedAt }
    }
    openIssues: issues(states: OPEN) { totalCount }
    closedIssues: issues(states: CLOSED) { totalCount }
    openPRs: pullRequests(states: OPEN) { totalCount }
    closedPRs: pullRequests(states: [CLOSED, MERGED]) { totalCount }
    oldestOpen: issues(states: OPEN, first: 1, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes { createdAt }
    }
  }
}
`;

const GQL_COMMIT_PAGE = `
query CommitPage($owner: String!, $name: String!, $since: GitTimestamp!, $after: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(since: $since, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              author { user { login } email name }
            }
          }
        }
      }
    }
  }
}
`;

type CommitAuthor = {
  user: { login: string } | null;
  email: string | null;
  name: string | null;
};
type CommitHistory = {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ author: CommitAuthor | null }>;
};

type GqlRepo = {
  isArchived: boolean;
  hasDiscussionsEnabled: boolean;
  owner: { __typename: "User" | "Organization" };
  defaultBranchRef: {
    name: string;
    target: {
      committedDate?: string;
      checkSuites?: { nodes: Array<{ status: string; conclusion: string | null; updatedAt: string }> };
      history?: CommitHistory;
    } | null;
  } | null;
  releases: { totalCount: number; nodes: Array<{ publishedAt: string | null }> };
  openIssues: { totalCount: number };
  closedIssues: { totalCount: number };
  openPRs: { totalCount: number };
  closedPRs: { totalCount: number };
  oldestOpen: { nodes: Array<{ createdAt: string }> };
};

async function gqlRepo(owner: string, name: string, since: string): Promise<GqlRepo | null> {
  const tok = await token();
  if (!tok) return null;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tok}`,
      "user-agent": "bun-audit",
    },
    body: JSON.stringify({ query: GQL_REPO, variables: { owner, name, since } }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { repository: GqlRepo | null }; errors?: unknown };
  return json.data?.repository ?? null;
}

async function gqlCommitPage(owner: string, name: string, since: string, after: string): Promise<CommitHistory | null> {
  const tok = await token();
  if (!tok) return null;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "user-agent": "bun-audit" },
    body: JSON.stringify({ query: GQL_COMMIT_PAGE, variables: { owner, name, since, after } }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { repository?: { defaultBranchRef?: { target?: { history?: CommitHistory } } } } };
  return json.data?.repository?.defaultBranchRef?.target?.history ?? null;
}

function authorKey(a: CommitAuthor | null): string | null {
  if (!a) return null;
  if (a.user?.login) return `login:${a.user.login}`;
  if (a.email) return `email:${a.email}`;
  if (a.name) return `name:${a.name}`;
  return null;
}

function isLikelyBot(a: CommitAuthor | null): boolean {
  if (!a) return false;
  if (a.user?.login && a.user.login.endsWith("[bot]")) return true;
  if (a.email && (a.email.endsWith("@users.noreply.github.com") && a.email.includes("[bot]"))) return true;
  return false;
}

async function fetchCommitStats(owner: string, name: string, sinceIso: string, repo: GqlRepo): Promise<{
  commits12: number;
  committers12: number;
  topShare: number | null;
  top3Share: number | null;
  truncated: boolean;
}> {
  const firstPage = repo.defaultBranchRef?.target?.history;
  if (!firstPage) return { commits12: 0, committers12: 0, topShare: null, top3Share: null, truncated: false };
  const perAuthor = new Map<string, number>();
  let total = 0;
  const consume = (page: CommitHistory) => {
    for (const c of page.nodes) {
      if (isLikelyBot(c.author)) continue;
      const k = authorKey(c.author);
      if (!k) continue;
      perAuthor.set(k, (perAuthor.get(k) ?? 0) + 1);
      total++;
    }
  };
  consume(firstPage);
  let cursor = firstPage.pageInfo.endCursor;
  let hasNext = firstPage.pageInfo.hasNextPage;
  const MAX_PAGES = 10; // cap at ~1000 commits
  let page = 1;
  let truncated = false;
  while (hasNext && cursor && page < MAX_PAGES) {
    const next = await gqlCommitPage(owner, name, sinceIso, cursor);
    if (!next) break;
    consume(next);
    cursor = next.pageInfo.endCursor;
    hasNext = next.pageInfo.hasNextPage;
    page++;
  }
  if (hasNext) truncated = true;

  const sorted = [...perAuthor.values()].sort((a, b) => b - a);
  const top1 = sorted[0] ?? 0;
  const top3 = sorted.slice(0, 3).reduce((s, n) => s + n, 0);
  return {
    commits12: total,
    committers12: perAuthor.size,
    topShare: total > 0 ? top1 / total : null,
    top3Share: total > 0 ? top3 / total : null,
    truncated,
  };
}

type MergedPrSearch = { total_count: number };

// GitHub Search API authenticated cap is 30 req/min. Throttle to ~25/min to
// leave headroom. Sequential queue, global across workers.
let searchQueue: Promise<unknown> = Promise.resolve();
const SEARCH_GAP_MS = 2500;

async function searchCount(owner: string, name: string, query: string): Promise<number | null> {
  const tok = await token();
  if (!tok) return null;
  const run = async (): Promise<number | null> => {
    const q = encodeURIComponent(`repo:${owner}/${name} ${query}`);
    const res = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
      headers: { authorization: `Bearer ${tok}`, accept: "application/vnd.github+json", "user-agent": "bun-audit" },
    });
    if (res.status === 403 || res.status === 429) {
      // Secondary rate limit. Back off and retry once.
      await new Promise((r) => setTimeout(r, 30000));
      const retry = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
        headers: { authorization: `Bearer ${tok}`, accept: "application/vnd.github+json", "user-agent": "bun-audit" },
      });
      if (!retry.ok) return null;
      const data = (await retry.json()) as MergedPrSearch;
      return data.total_count ?? null;
    }
    if (!res.ok) return null;
    const data = (await res.json()) as MergedPrSearch;
    return data.total_count ?? null;
  };
  // Chain onto the global queue so calls happen sequentially with spacing.
  const next = searchQueue.then(async () => {
    const result = await run();
    await new Promise((r) => setTimeout(r, SEARCH_GAP_MS));
    return result;
  });
  searchQueue = next.catch(() => undefined);
  return next as Promise<number | null>;
}

function pickCiStatus(suites?: { nodes: Array<{ status: string; conclusion: string | null; updatedAt: string }> }): {
  status: string | null;
  at: string | null;
} {
  if (!suites?.nodes || suites.nodes.length === 0) return { status: null, at: null };
  const sorted = [...suites.nodes].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const top = sorted[0];
  return { status: top.conclusion ?? top.status ?? null, at: top.updatedAt };
}

export async function fetchGithubSignals(owner: string, name: string): Promise<Sourced<GithubSignals> | null> {
  const cacheKey = `${owner}/${name}`;
  const cached = await cache.get<Sourced<GithubSignals>>(cacheKey);
  if (cached) return cached;

  const sinceIso = new Date(Date.now() - 365 * DAY).toISOString();
  const repo = await gqlRepo(owner, name, sinceIso);
  if (!repo) return null;

  const stats = await fetchCommitStats(owner, name, sinceIso, repo);

  const since = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);
  // Single search call per repo to stay under the 30/min cap on most projects.
  // Other 12mo counts (issues_opened/closed) come from the responsiveness
  // source, which already paginates issues directly.
  const mergedPrs12 = await searchCount(owner, name, `is:pr is:merged merged:>=${since}`);
  const issuesOpened12: number | null = null;
  const issuesClosed12: number | null = null;

  const commitDate = repo.defaultBranchRef?.target?.committedDate ?? null;
  const lastCommit = commitDate ? new Date(commitDate) : null;
  const ci = pickCiStatus(repo.defaultBranchRef?.target?.checkSuites);
  const now = Date.now();

  const oldestOpenIssueAge = repo.oldestOpen.nodes[0]?.createdAt
    ? Math.floor((now - new Date(repo.oldestOpen.nodes[0].createdAt).getTime()) / DAY)
    : null;

  const out: Sourced<GithubSignals> = {
    _source: "api.github.com",
    _fetched_at: new Date().toISOString(),
    repo_archived: repo.isArchived,
    owner_type: repo.owner.__typename,
    last_commit_iso: lastCommit ? lastCommit.toISOString() : null,
    days_since_last_commit: lastCommit ? Math.floor((now - lastCommit.getTime()) / DAY) : null,
    default_branch: repo.defaultBranchRef?.name ?? null,
    default_branch_last_ci_status: ci.status,
    default_branch_last_ci_run_at: ci.at,
    last_release_iso: repo.releases.nodes[0]?.publishedAt ?? null,
    releases_total: repo.releases.totalCount,
    open_issues: repo.openIssues.totalCount,
    closed_issues: repo.closedIssues.totalCount,
    open_prs: repo.openPRs.totalCount,
    closed_prs: repo.closedPRs.totalCount,
    merged_prs_12mo: mergedPrs12,
    issues_closed_12mo: issuesClosed12,
    issues_opened_12mo: issuesOpened12,
    oldest_open_issue_age_days: oldestOpenIssueAge,
    committers_12mo: stats.committers12,
    commits_12mo: stats.commits12,
    commits_12mo_truncated: stats.truncated,
    top_committer_commit_share_12mo: stats.topShare,
    top3_committer_commit_share_12mo: stats.top3Share,
    has_discussions_enabled: repo.hasDiscussionsEnabled,
  };

  await cache.set(cacheKey, out);
  return out;
}
