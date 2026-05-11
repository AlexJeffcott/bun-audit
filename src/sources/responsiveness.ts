import { Cache, DAY } from "../cache.ts";
import type { ResponsivenessSignals, Sourced } from "../types.ts";

const cache = new Cache("responsiveness", DAY);

const GUT_FEEL_ACK_THEN_SILENT_DAYS = 90;
const GUT_FEEL_STALE_BOT_QUIET_WINDOW_DAYS = 30;
const GUT_FEEL_TRIAGED_STALLED_DAYS = 90;

let cachedToken: string | null = null;
async function token(): Promise<string | null> {
  if (cachedToken !== null) return cachedToken;
  const envTok = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envTok) return (cachedToken = envTok);
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    cachedToken = out || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

const MAINTAINER_ASSOC = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CONSUMER_ASSOC = new Set(["NONE", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR", "FIRST_TIMER"]);

const GQL = `
query Issues($owner: String!, $name: String!, $cursor: String, $since: DateTime!) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: { since: $since }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        createdAt
        closedAt
        state
        stateReason
        authorAssociation
        author { login __typename ... on Bot { __typename } }
        comments(first: 50) {
          nodes {
            createdAt
            authorAssociation
            author { login __typename ... on Bot { __typename } }
          }
        }
        timelineItems(first: 50, itemTypes: [LABELED_EVENT, ASSIGNED_EVENT, CLOSED_EVENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login __typename } }
            ... on AssignedEvent { createdAt actor { login __typename } }
            ... on ClosedEvent { createdAt actor { login __typename } stateReason }
          }
        }
      }
    }
  }
}
`;

type Actor = { login?: string; __typename?: string };
type Comment = { createdAt: string; authorAssociation: string; author: Actor | null };
type Timeline =
  | { __typename: "LabeledEvent"; createdAt: string; actor: Actor | null }
  | { __typename: "AssignedEvent"; createdAt: string; actor: Actor | null }
  | { __typename: "ClosedEvent"; createdAt: string; actor: Actor | null; stateReason?: string | null };

type Issue = {
  number: number;
  createdAt: string;
  closedAt: string | null;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | "DUPLICATE" | null;
  authorAssociation: string;
  author: Actor | null;
  comments: { nodes: Comment[] };
  timelineItems: { nodes: Timeline[] };
};

function isBot(a: Actor | null): boolean {
  if (!a) return false;
  if (a.__typename === "Bot") return true;
  if (a.login && a.login.endsWith("[bot]")) return true;
  return false;
}

type Bucket =
  | "no_response"
  | "bot_only_response"
  | "acknowledged_then_silent"
  | "stale_bot_closed"
  | "closed_without_engagement"
  | "closed_not_planned"
  | "triaged_stalled"
  | "resolved"
  | "skip";

function classify(issue: Issue, now: number): { bucket: Bucket; firstResponseHours: number | null } {
  // Restrict to consumer-authored issues.
  if (!CONSUMER_ASSOC.has(issue.authorAssociation)) return { bucket: "skip", firstResponseHours: null };
  if (isBot(issue.author)) return { bucket: "skip", firstResponseHours: null };

  const comments = issue.comments.nodes;
  const maintainerComments = comments.filter((c) => MAINTAINER_ASSOC.has(c.authorAssociation) && !isBot(c.author));
  const nonBotComments = comments.filter((c) => !isBot(c.author));
  const botComments = comments.filter((c) => isBot(c.author));

  const created = new Date(issue.createdAt).getTime();
  const firstMaint = maintainerComments[0] ? new Date(maintainerComments[0].createdAt).getTime() : null;
  const firstResponseHours = firstMaint !== null ? (firstMaint - created) / (1000 * 60 * 60) : null;

  // Close events
  const closeEvent = issue.timelineItems.nodes.find((t) => t.__typename === "ClosedEvent") as
    | (Timeline & { __typename: "ClosedEvent" })
    | undefined;

  // Open issues
  if (issue.state === "OPEN") {
    if (maintainerComments.length === 0 && nonBotComments.length === 0 && botComments.length === 0) {
      return { bucket: "no_response", firstResponseHours };
    }
    if (maintainerComments.length === 0 && botComments.length > 0 && nonBotComments.length === 0) {
      return { bucket: "bot_only_response", firstResponseHours };
    }
    if (maintainerComments.length === 0) {
      // Non-bot comments exist (from other consumers), but no maintainer
      return { bucket: "no_response", firstResponseHours };
    }
    // Maintainer commented at least once. Check if silent for > N days.
    const lastMaintAt = maintainerComments[maintainerComments.length - 1].createdAt;
    const ageDays = (now - new Date(lastMaintAt).getTime()) / DAY;
    if (ageDays > GUT_FEEL_ACK_THEN_SILENT_DAYS) {
      // Was it triaged with a label/assign?
      const hasTriage = issue.timelineItems.nodes.some(
        (t) => t.__typename === "LabeledEvent" || t.__typename === "AssignedEvent",
      );
      if (hasTriage) return { bucket: "triaged_stalled", firstResponseHours };
      return { bucket: "acknowledged_then_silent", firstResponseHours };
    }
    // Still actively engaged or recent — not "ignored"
    return { bucket: "skip", firstResponseHours };
  }

  // Closed issues
  if (closeEvent && isBot(closeEvent.actor)) {
    // Was a maintainer recently engaged before the bot closed?
    const closedAt = new Date(closeEvent.createdAt).getTime();
    const lastMaintBefore = maintainerComments.filter(
      (c) => new Date(c.createdAt).getTime() < closedAt,
    );
    const lastMaintTime = lastMaintBefore.length > 0
      ? new Date(lastMaintBefore[lastMaintBefore.length - 1].createdAt).getTime()
      : null;
    const quietWindowMs = GUT_FEEL_STALE_BOT_QUIET_WINDOW_DAYS * DAY;
    const stale = lastMaintTime === null || closedAt - lastMaintTime > quietWindowMs;
    if (stale) return { bucket: "stale_bot_closed", firstResponseHours };
  }

  if (maintainerComments.length === 0) {
    return { bucket: "closed_without_engagement", firstResponseHours };
  }

  if (issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE") {
    return { bucket: "closed_not_planned", firstResponseHours };
  }

  return { bucket: "resolved", firstResponseHours };
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

export async function fetchResponsivenessSignals(
  owner: string,
  name: string,
): Promise<Sourced<ResponsivenessSignals> | null> {
  const cacheKey = `${owner}/${name}`;
  const cached = await cache.get<Sourced<ResponsivenessSignals>>(cacheKey);
  if (cached) return cached;

  const tok = await token();
  if (!tok) return null;

  const since = new Date(Date.now() - 365 * DAY).toISOString();
  let cursor: string | null = null;
  const issues: Issue[] = [];
  // Cap at 200 issues to bound cost.
  for (let page = 0; page < 4; page++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tok}`,
        "user-agent": "bun-audit",
      },
      body: JSON.stringify({ query: GQL, variables: { owner, name, cursor, since } }),
    });
    if (!res.ok) break;
    const json = (await res.json()) as {
      data?: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Issue[];
          };
        } | null;
      };
      errors?: unknown;
    };
    const node = json.data?.repository?.issues;
    if (!node) break;
    issues.push(...node.nodes);
    if (!node.pageInfo.hasNextPage) break;
    cursor = node.pageInfo.endCursor;
  }

  // Filter to issues created in last 12mo (the filterBy uses `since` which is
  // by updated, so old issues may sneak in; trim by createdAt to be safe).
  const cutoff = Date.now() - 365 * DAY;
  const recent = issues.filter((i) => new Date(i.createdAt).getTime() >= cutoff);

  const now = Date.now();
  const counts: Record<Bucket, number> = {
    no_response: 0,
    bot_only_response: 0,
    acknowledged_then_silent: 0,
    stale_bot_closed: 0,
    closed_without_engagement: 0,
    closed_not_planned: 0,
    triaged_stalled: 0,
    resolved: 0,
    skip: 0,
  };
  const firstResponseHours: number[] = [];
  let awaitingFirst = 0;
  let oldestAwaitingDays = 0;
  let consumerCount = 0;

  for (const issue of recent) {
    const { bucket, firstResponseHours: fr } = classify(issue, now);
    counts[bucket]++;
    if (bucket === "skip") continue;
    consumerCount++;
    if (fr !== null && fr >= 0) firstResponseHours.push(fr);
    if (issue.state === "OPEN" && fr === null) {
      awaitingFirst++;
      const age = (now - new Date(issue.createdAt).getTime()) / DAY;
      if (age > oldestAwaitingDays) oldestAwaitingDays = age;
    }
  }

  firstResponseHours.sort((a, b) => a - b);

  const out: Sourced<ResponsivenessSignals> = {
    _source: "api.github.com",
    _fetched_at: new Date().toISOString(),
    consumer_issues_opened_12mo: consumerCount,
    consumer_issues_no_response_12mo: counts.no_response,
    consumer_issues_bot_only_response_12mo: counts.bot_only_response,
    consumer_issues_acknowledged_then_silent_12mo: counts.acknowledged_then_silent,
    consumer_issues_stale_bot_closed_12mo: counts.stale_bot_closed,
    consumer_issues_closed_without_engagement_12mo: counts.closed_without_engagement,
    consumer_issues_closed_not_planned_12mo: counts.closed_not_planned,
    consumer_issues_triaged_stalled_12mo: counts.triaged_stalled,
    consumer_issues_resolved_12mo: counts.resolved,
    median_first_maintainer_response_hours_12mo: quantile(firstResponseHours, 0.5),
    p90_first_maintainer_response_hours_12mo: quantile(firstResponseHours, 0.9),
    issues_still_awaiting_first_response: awaitingFirst,
    oldest_awaiting_first_response_days: Math.floor(oldestAwaitingDays),
  };

  await cache.set(cacheKey, out);
  return out;
}
