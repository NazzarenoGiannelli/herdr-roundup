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
    case "HeadRefForcePushedEvent":
      return { kind: "forcepush", author: login(n.actor), at: n.createdAt, after: n.afterCommit?.abbreviatedOid ?? null };
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
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const current = repo.pullRequest ? currentContexts(rollup) : null;
  const checks = current ? normalizeChecks(current.nodes) : null;
  return {
    body: node.body ?? "",
    mergeable: node.mergeable ?? null,
    mergeState: node.mergeStateStatus ?? null,
    additions: node.additions ?? null,
    deletions: node.deletions ?? null,
    changedFiles: node.changedFiles ?? null,
    checks, // issues have none
    // What the merge button re-checks (PR only): draft state, refs, the head commit and the rollup state.
    isDraft: repo.pullRequest ? !!node.isDraft : null,
    head: node.headRefName ?? null,
    base: node.baseRefName ?? null,
    headOid: node.headRefOid ?? null,
    // The rollup's state, unless a superseded run was dropped from the checks: GitHub's rollup still counts that run's
    // cancelled checks as failing, so the state is then read from the checks that count.
    ci: repo.pullRequest ? (current.superseded ? ciOfChecks(checks) : ciFromRollup(rollup?.state ?? null)) : null,
    timeline,
    // The branch's commits (the last 100, oldest first), who was asked for a review, each reviewer's latest review.
    commits: repo.pullRequest ? normalizeCommits(node.history) : null,
    commitCount: repo.pullRequest ? (node.history?.totalCount ?? null) : null,
    reviewRequests: repo.pullRequest ? ((node.reviewRequests?.nodes) || []).map((r) => requested(r?.requestedReviewer)).filter(Boolean) : null,
    latestReviews: repo.pullRequest ? ((node.latestReviews?.nodes) || []).filter(Boolean)
      .map((r) => ({ author: login(r.author), avatar: avatarOf(r.author), state: r.state ?? null, at: r.submittedAt ?? null })) : null,
  };
}

function normalizeCommits(history) {
  return ((history?.nodes) || []).map((n) => n?.commit).filter((c) => c && c.oid).map((c) => ({
    oid: c.oid,
    short: c.abbreviatedOid || c.oid.slice(0, 7),
    title: c.messageHeadline ?? "",
    at: c.committedDate ?? null,
    url: c.url ?? null,
    author: c.author?.user?.login ?? "",
    authorName: c.author?.name ?? "",
    avatar: c.author?.user?.avatarUrl ?? null,
    ci: c.statusCheckRollup ? ciFromRollup(c.statusCheckRollup.state ?? null) : "none",
  }));
}

// A requested reviewer: a person or bot by login, a team by name.
function requested(r) {
  if (!r) return null;
  const who = r.__typename === "Team" ? r.name : r.login;
  return who ? { who, avatar: r.avatarUrl ?? null, team: r.__typename === "Team" } : null;
}

// Whether a running check has started: a CheckRun in progress runs, one queued, waiting or
// requested has not; a StatusContext only says pending, so it counts as running.
function checkPhase(n) {
  if (n.__typename === "StatusContext") return "running";
  return n.status === "IN_PROGRESS" ? "running" : "queued";
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

// The workflow run a CheckRun belongs to, or null: a StatusContext, or a check outside GitHub Actions.
function runOf(n) {
  const r = n?.__typename === "CheckRun" ? n.checkSuite?.workflowRun : null;
  const workflow = r?.workflow?.name;
  if (!r || !workflow) return null;
  const number = r.runNumber ?? 0;
  const at = r.createdAt ?? "";
  return { workflow, key: r.databaseId != null ? `id:${r.databaseId}` : `${number}@${at}`, number, at };
}

// Whether run a came after run b: the later createdAt (ISO-8601 UTC sorts lexically), then the higher run number.
function later(a, b) {
  return a.at !== b.at ? a.at > b.at : a.number > b.number;
}

// The head commit's checks that still count. GitHub keeps the checks of a workflow run that a newer run of the same
// workflow replaced on the same commit: a CI that cancels the older run when a newer event arrives for the PR leaves a
// cancelled job and an aggregator whose name was never evaluated, both read as failing although GitHub calls the PR
// CLEAN (trace#245, 2026-11-15). When the list is complete, only the latest run of each workflow is kept; checks with
// no workflow run (StatusContexts, other apps) stay. A truncated list is kept whole, and the rollup decides as before.
function currentContexts(rollup) {
  const nodes = ((rollup?.contexts?.nodes) || []).filter(Boolean);
  const total = rollup?.contexts?.totalCount;
  if (typeof total !== "number" || nodes.length !== total) return { nodes, superseded: false };
  const latest = new Map();
  for (const n of nodes) {
    const r = runOf(n);
    if (!r) continue;
    const best = latest.get(r.workflow);
    if (!best || later(r, best)) latest.set(r.workflow, r);
  }
  const kept = nodes.filter((n) => {
    const r = runOf(n);
    return !r || r.key === latest.get(r.workflow).key;
  });
  return { nodes: kept, superseded: kept.length !== nodes.length };
}

// The CI state of the checks that count, in the rollup's words: failing if one fails, running if one runs, passing
// otherwise (skipped and neutral pass). A cancelled check of the latest run still fails, as before.
function ciOfChecks(checks) {
  if (checks.some((c) => c.state === "failure")) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return checks.length ? "success" : "none";
}

function normalizeChecks(nodes) {
  return (nodes || []).filter(Boolean).map((n) => {
    const status = n.__typename === "StatusContext";
    const state = checkState(n);
    return {
      name: status ? n.context : n.name,
      state,
      phase: state === "pending" ? checkPhase(n) : null,
      startedAt: (status ? n.createdAt : n.startedAt) ?? null,
      completedAt: status ? null : (n.completedAt ?? null),
      url: (status ? n.targetUrl : n.detailsUrl) ?? null,
    };
  });
}

export function truncated(text, max = 60000) {
  const s = text == null ? "" : String(text);
  return s.length > max ? { text: s.slice(0, max), cut: true } : { text: s, cut: false };
}
