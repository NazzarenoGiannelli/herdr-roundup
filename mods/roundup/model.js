// Normalises GitHub GraphQL responses (queries in the plan's queries.md) into
// the flat shapes the panel uses. Pure: the only import is ./rules.js, since
// this file is loaded both by Node tests and by the Herdr runtime.

import { ciFromRollup } from "./rules.js";

const names = (conn) => ((conn && conn.nodes) || []).filter(Boolean).map((n) => n.name);
const login = (u) => (u && u.login) || "";
const avatarOf = (u) => (u && u.avatarUrl) || null;

function normalizePR(n) {
  return {
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    isDraft: !!n.isDraft,
    updatedAt: n.updatedAt,
    head: n.headRefName,
    base: n.baseRefName,
    author: login(n.author),
    avatar: avatarOf(n.author),
    labels: names(n.labels),
    ci: ciFromRollup(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null),
    reviewDecision: n.reviewDecision ?? null,
    comments: ((n.comments && n.comments.nodes) || []).filter(Boolean).map((c) => ({
      author: login(c.author),
      body: c.bodyText ?? "",
      createdAt: c.createdAt,
    })),
    ...(n.mergedAt ? merged(n) : {}),
  };
}

// Only PRs from the merged list carry these. Two parents: a merge commit; one: squash (a rebase
// merge also has one and is not told apart).
function merged(n) {
  const parents = n.mergeCommit?.parents?.totalCount;
  return { merged: true, mergedAt: n.mergedAt, mergedBy: login(n.mergedBy), method: parents === 2 ? "merge" : parents === 1 ? "squash" : null };
}

function normalizeIssue(n) {
  return {
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    updatedAt: n.updatedAt,
    author: login(n.author),
    avatar: avatarOf(n.author),
    labels: names(n.labels),
  };
}

// A search hit that is not the expected type comes back as `{}` (the inline
// fragment did not match); those carry no number and are skipped.
function searchItems(graphql, map) {
  const search = graphql?.data?.search || {};
  const items = (search.nodes || []).filter((n) => n && n.number != null).map(map);
  // `warning`: set by parseGraphql when the search answered with results and errors (the list is partial).
  return { items, total: search.issueCount ?? items.length, warning: graphql?.warning ?? null };
}

export const normalizePRs = (graphql) => searchItems(graphql, normalizePR);
export const normalizeIssues = (graphql) => searchItems(graphql, normalizeIssue);

function timelineEntry(n) {
  switch (n.__typename) {
    case "IssueComment":
      return { kind: "comment", author: login(n.author), avatar: avatarOf(n.author), at: n.createdAt, body: n.body ?? "" };
    case "PullRequestReview":
      return { kind: "review", author: login(n.author), avatar: avatarOf(n.author), at: n.createdAt, body: n.body ?? "", state: n.state };
    case "LabeledEvent":
      return { kind: "labeled", author: login(n.actor), at: n.createdAt, label: n.label?.name ?? "" };
    default:
      return null;
  }
}

// Accepts both `repository.pullRequest` and `repository.issue`. For an issue
// the PR-only fields are null.
export function normalizeDetail(graphql) {
  const repo = graphql?.data?.repository || {};
  const node = repo.pullRequest || repo.issue || {};
  const timeline = ((node.timelineItems && node.timelineItems.nodes) || [])
    .filter(Boolean)
    .map(timelineEntry)
    .filter(Boolean)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // ISO-8601 UTC sorts lexically; stable for ties
  return {
    body: node.body ?? "",
    mergeable: node.mergeable ?? null,
    mergeState: node.mergeStateStatus ?? null,
    additions: node.additions ?? null,
    deletions: node.deletions ?? null,
    changedFiles: node.changedFiles ?? null,
    checks: repo.pullRequest ? normalizeChecks(node) : null, // issues have none
    // What the merge button re-checks (PR only): draft state, refs, the head commit and the rollup state.
    isDraft: repo.pullRequest ? !!node.isDraft : null,
    head: node.headRefName ?? null,
    base: node.baseRefName ?? null,
    headOid: node.headRefOid ?? null,
    ci: repo.pullRequest ? ciFromRollup(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null) : null,
    timeline,
  };
}

// A check's state: CheckRun by status/conclusion, StatusContext by state.
function checkState(n) {
  if (n.__typename === "StatusContext") {
    return n.state === "SUCCESS" ? "success" : n.state === "FAILURE" || n.state === "ERROR" ? "failure" : "pending";
  }
  if (n.status && n.status !== "COMPLETED") return "pending";
  switch (n.conclusion) {
    case "SUCCESS": return "success";
    case "SKIPPED": return "skipped";
    case "NEUTRAL": return "neutral";
    case "FAILURE": case "TIMED_OUT": case "CANCELLED": case "ACTION_REQUIRED": case "STARTUP_FAILURE": case "STALE": return "failure";
    default: return "pending";
  }
}

function normalizeChecks(node) {
  const nodes = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  return (nodes || []).filter(Boolean).map((n) => ({ name: n.__typename === "StatusContext" ? n.context : n.name, state: checkState(n) }));
}

export function truncated(text, max = 60000) {
  const s = text == null ? "" : String(text);
  return s.length > max ? { text: s.slice(0, max), cut: true } : { text: s, cut: false };
}
