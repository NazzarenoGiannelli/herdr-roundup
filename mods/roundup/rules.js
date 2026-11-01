// Pure rules for the Roundup panel. The only import is ./config.js (also pure): this file is
// loaded both by Node tests and by the Herdr runtime, which has no Node APIs. Rules that depend on
// the person's config take it as the last argument and fall back to the defaults without one.

import { DEFAULT_CONFIG, hasLabel, isReviewer } from "./config.js";

const CHANGES_PREFIX = "CHANGES REQUESTED";

// GitHub's decision, else the latest comment by one of config.reviewers.
export function reviewState(pr, config = DEFAULT_CONFIG) {
  if (pr.reviewDecision === "APPROVED") return "approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  const mine = (pr.comments || []).filter((c) => isReviewer(c.author, config));
  if (mine.length === 0) return "none";
  const latest = mine.reduce((a, b) => (String(b.createdAt) >= String(a.createdAt) ? b : a));
  return String(latest.body || "").trim().startsWith(CHANGES_PREFIX) ? "changes" : "approved";
}

export function ciFromRollup(state) {
  switch (state) {
    case "SUCCESS": return "success";
    case "PENDING":
    case "EXPECTED": return "pending";
    case "FAILURE":
    case "ERROR": return "failure";
    default: return "none";
  }
}

// Which views a PR is in. Built in: Ready = CI passing and approved, In review = no review yet,
// Dependencies = opened by a dependency bot. config.labels adds PRs to a view on top of that.
// GitHub's GraphQL names a bot without the suffix ("dependabot"); the REST API and the web page say
// "dependabot[bot]" and some tools "app/dependabot". All three are the same bot.
export const DEPENDENCY_BOTS = ["dependabot", "renovate"];
export const botName = (login) => String(login ?? "").trim().toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
export const isDependencyBot = (login) => DEPENDENCY_BOTS.includes(botName(login));
export function views(pr, config = DEFAULT_CONFIG) {
  const labels = pr.labels || [];
  const review = reviewState(pr, config);
  const out = [];
  if (hasLabel(labels, config.labels.ready) || (pr.ci === "success" && review === "approved")) out.push("ready");
  if (hasLabel(labels, config.labels.review) || review === "none") out.push("review");
  if (isDependencyBot(pr.author) || hasLabel(labels, config.labels.deps)) out.push("deps");
  if (pr.isDraft) out.push("drafts");
  return out;
}

// Whose move a PR is: the group it is listed under, first match wins, drafts always last.
//   ready    built-in ready signal or a labels.ready label (a PR with a green light and nothing to wait for)
//   review   no review yet, and CI is not failing: the reviewer's move
//   fixing   CI failing or changes requested: the author's move
//   waiting  CI still running
//   drafts   drafts
// An approved PR with no CI at all has nothing left to wait for, so it is "ready" too: every PR lands in one group.
export const GROUP_IDS = ["ready", "review", "fixing", "waiting", "drafts"];
export function groupOf(pr, config = DEFAULT_CONFIG) {
  if (pr.isDraft) return "drafts";
  if (views(pr, config).includes("ready")) return "ready";
  const review = reviewState(pr, config);
  // Waiting for a review: nobody has reviewed it yet, or it carries a `labels.review` label.
  if (pr.ci !== "failure" && review !== "changes" && (review === "none" || hasLabel(pr.labels, config.labels.review))) return "review";
  if (pr.ci === "failure" || review === "changes") return "fixing";
  if (pr.ci === "pending") return "waiting";
  return "ready";
}

// The merge method a PR starts with.
// With config.stagingFlow (feature branches -> a long-lived `staging` branch -> `main`): back-merges
// and releases keep their history, so they are merge commits whether or not the repository has a
// `staging` branch (a squash would break the rule that staging contains everything on main). The
// rest depends on the branch: with one, a PR into main is a release (merge commit) and the others
// squash; without one, history decides.
// Without it: whatever the last merged PR into the same base used (repo.lastMethod), else squash.
export function defaultMethod(pr, repo, config = DEFAULT_CONFIG) {
  if (!config.stagingFlow) return repo.lastMethod || "squash";
  const head = typeof pr.head === "string" ? pr.head : "";
  if (head === "main" && pr.base === "staging") return "merge";
  if (head.startsWith("backmerge/")) return "merge";
  if (head === "staging" && pr.base === "main") return "merge";
  if (repo.hasStaging) return pr.base === "main" ? "merge" : "squash";
  return repo.lastMethod || "squash";
}

export function methodChoices(settings, allowedByRules) {
  return ["squash", "merge", "rebase"].map((method) => {
    if (!settings[method]) return { method, enabled: false, reason: "Disabled in this repository's settings" };
    if (allowedByRules && !allowedByRules.includes(method)) return { method, enabled: false, reason: "Not allowed on this branch" };
    return { method, enabled: true, reason: null };
  });
}

// The names of up to three checks in `state`, then "+N more"; "" when the loaded checks have none in that
// state. A name that appears twice (two workflows with a `build` job) is listed once.
export const NAMED_CHECKS = 3;
export function checkNames(checks, state) {
  const named = [...new Set((Array.isArray(checks) ? checks : []).filter((c) => c && c.state === state && c.name).map((c) => c.name))];
  if (named.length === 0) return "";
  const shown = named.slice(0, NAMED_CHECKS).join(", ");
  return named.length > NAMED_CHECKS ? `${shown} +${named.length - NAMED_CHECKS} more` : shown;
}

// Why a PR can't be merged, or null. `detail.checks` (the loaded checks, optional) names the failing or
// running ones; without them the text is the plain one.
export function mergeBlock(detail) {
  if (detail.ci === "failure") {
    const names = checkNames(detail.checks, "failure");
    return names ? `CI failing: ${names}` : "CI is failing";
  }
  if (detail.ci === "pending") {
    const names = checkNames(detail.checks, "pending");
    return names ? `CI running: ${names}` : "CI is still running";
  }
  if (detail.mergeable === "CONFLICTING") return "Has conflicts";
  if (detail.mergeable === "UNKNOWN") return "GitHub hasn't computed mergeability yet, try ⟳ in a moment";
  if (detail.mergeState === "BLOCKED") return "Blocked by branch protection";
  return null;
}

const LABELS = {
  squash: { plain: "Squash and merge", confirm: "Confirm squash and merge", draft: "Mark ready and squash and merge" },
  merge: { plain: "Merge pull request", menu: "Create a merge commit", confirm: "Confirm merge", draft: "Mark ready and merge" },
  rebase: { plain: "Rebase and merge", confirm: "Confirm rebase and merge", draft: "Mark ready and rebase and merge" },
};

export function labelFor(method, { confirm, draft }) {
  const l = LABELS[method];
  // A draft says what will happen before the first click too: it is marked ready, then merged.
  if (draft) return confirm ? `Confirm ${l.draft[0].toLowerCase()}${l.draft.slice(1)}` : l.draft;
  return confirm ? l.confirm : l.plain;
}

// Name in the ▾ menu. GitHub's button says "Merge pull request", its menu "Create a merge commit".
export function menuLabel(method) {
  const l = LABELS[method];
  return l.menu ?? l.plain;
}

export function chips(items) {
  const counts = new Map();
  for (const { repo } of items) counts.set(repo, (counts.get(repo) || 0) + 1);
  return [...counts].map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}
