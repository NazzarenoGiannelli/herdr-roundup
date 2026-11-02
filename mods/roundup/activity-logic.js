// Pure logic for the detail's ACTIVITY and REVIEW parts: commits woven into the conversation, and
// who is reviewing. Imports only ./config.js and ./rules.js (loaded by Node tests and by the Herdr runtime).

import { DEFAULT_CONFIG, isReviewer } from "./config.js";
import { CHANGES_PREFIX } from "./rules.js";

const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0); // ISO-8601 UTC sorts lexically; stable for ties
const authorOf = (c) => String(c.author || c.authorName || "").toLowerCase();

// The conversation and the commits as one thread, oldest first. Commits in a row by the same author
// become one entry, { kind: "commits", id, author, avatar, at, commits }, so a long series of pushes
// does not bury the comments. `id` is the group's first commit, `at` its newest.
export function activity(timeline, commits) {
  const talk = (Array.isArray(timeline) ? timeline : []).filter(Boolean);
  const pushed = (Array.isArray(commits) ? commits : []).filter((c) => c && c.oid && c.at)
    .map((c) => ({ kind: "commit", at: c.at, commit: c }));
  const all = [...talk, ...pushed].sort(byTime);
  const out = [];
  for (const e of all) {
    if (e.kind !== "commit") { out.push(e); continue; }
    const last = out[out.length - 1];
    if (last && last.kind === "commits" && authorOf(last.commits[0]) === authorOf(e.commit)) {
      last.commits.push(e.commit); last.at = e.at;
    } else {
      out.push({ kind: "commits", id: e.commit.oid, author: e.commit.author || e.commit.authorName || "", avatar: e.commit.avatar ?? null, at: e.at, commits: [e.commit] });
    }
  }
  return out;
}

// A group of commits starts open when it is the newest entry of the thread (the push the person
// most likely came to look at) or has a single commit; `toggled` (a Set of group ids) flips it.
export function groupOpen(group, isNewest, toggled = new Set()) {
  const base = isNewest || group.commits.length === 1;
  return toggled.has(group.id) ? !base : base;
}

// "pushed 4 commits", "pushed a commit".
export const pushedLabel = (n) => n === 1 ? "pushed a commit" : `pushed ${n} commits`;

// More commits than the detail fetched: the older ones are on GitHub.
export const hasOlderCommits = (detail) => Boolean(detail) && Number(detail.commitCount) > (Array.isArray(detail.commits) ? detail.commits.length : 0);

// --- review -----------------------------------------------------------------------------------

const REVIEW_ORDER = { reviewing: 0, requested: 1, changes: 2, approved: 3, reviewed: 3, commented: 4, dismissed: 5 };
const FROM_GITHUB = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", DISMISSED: "dismissed" };
const lower = (s) => String(s ?? "").toLowerCase();

// A running check that is a review: its name says "review" ("claude-review", "security-review").
const isReviewCheck = (c) => c && c.state === "pending" && /review/i.test(String(c.name ?? ""));

// Who is reviewing and where each stands, one row per person (or per review check):
//   reviewing  a review check is running (named after a reviewer, it is that reviewer's row)
//   requested  asked for a review and has not answered yet
//   changes / approved / commented / dismissed  their latest review on GitHub
//   changes / reviewed  for a login in config.reviewers, their latest comment (CHANGES_PREFIX means
//              changes, anything else counts as reviewed, as in rules.reviewState), when it is newer
// Rows: { who, avatar, state, at, url }, ordered by state then name.
export function reviewRows(detail, config = DEFAULT_CONFIG) {
  if (!detail) return [];
  const rows = new Map(); // lower(who) -> row
  const put = (who, row) => { if (who) rows.set(lower(who), { who, avatar: null, at: null, url: null, ...row }); };
  for (const r of Array.isArray(detail.latestReviews) ? detail.latestReviews : []) {
    const state = FROM_GITHUB[r?.state];
    if (state) put(r.author, { avatar: r.avatar ?? null, state, at: r.at ?? null });
  }
  for (const e of Array.isArray(detail.timeline) ? detail.timeline : []) {
    if (e?.kind !== "comment" || !isReviewer(e.author, config)) continue;
    const had = rows.get(lower(e.author));
    if (had && had.at && String(had.at) >= String(e.at)) continue;
    put(e.author, { avatar: e.avatar ?? had?.avatar ?? null, state: String(e.body ?? "").trim().startsWith(CHANGES_PREFIX) ? "changes" : "reviewed", at: e.at });
  }
  for (const r of Array.isArray(detail.reviewRequests) ? detail.reviewRequests : []) {
    const had = rows.get(lower(r?.who));
    put(r?.who, { avatar: r?.avatar ?? had?.avatar ?? null, state: "requested", at: null });
  }
  for (const c of (Array.isArray(detail.checks) ? detail.checks : []).filter(isReviewCheck)) {
    const owner = (config.reviewers || []).find((login) => lower(c.name).startsWith(lower(login)));
    const had = owner ? rows.get(lower(owner)) : null;
    put(owner ? (had?.who ?? owner) : c.name, { avatar: had?.avatar ?? null, state: "reviewing", at: c.startedAt ?? null, url: c.url ?? null, check: owner ? c.name : null });
  }
  return [...rows.values()].sort((a, b) => REVIEW_ORDER[a.state] - REVIEW_ORDER[b.state] || (lower(a.who) < lower(b.who) ? -1 : lower(a.who) > lower(b.who) ? 1 : 0));
}

// The words after the name, with a tone for the colour.
export function reviewRowLabel(state) {
  switch (state) {
    case "reviewing": return { text: "reviewing…", tone: "warn" };
    case "requested": return { text: "waiting for a review", tone: "dim" };
    case "changes": return { text: "requested changes", tone: "bad" };
    case "approved": return { text: "approved", tone: "good" };
    case "reviewed": return { text: "reviewed", tone: "good" };
    case "commented": return { text: "commented", tone: "dim" };
    default: return { text: "dismissed", tone: "dim" };
  }
}
