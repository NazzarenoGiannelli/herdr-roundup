// Pure logic for "Update branch": how far a pull request's branch is behind its base, what the bar
// shows about it, and the gh arguments of the update. Imports only ./rules.js (loaded by Node tests
// and by the Herdr runtime).
//
// An update merges the base into the pull request's branch (a merge commit on the branch, like
// GitHub's "Update branch" button). Never a rebase: that rewrites the branch and force-pushes it.

import { isDependencyBot } from "./rules.js";

// `gh api repos/{repo}/compare/{headOid}...{base}`: `ahead_by` counts the base's commits the branch
// lacks (how far it is behind), `base_commit` is the branch's head commit (when it was last pushed).
export function behindFromCompare(json) {
  const count = Number(json?.ahead_by);
  if (!Number.isInteger(count) || count < 0) throw new Error("GitHub returned an unreadable comparison");
  const c = json?.base_commit?.commit;
  return { count, lastCommitAt: c?.committer?.date ?? c?.author?.date ?? null };
}

// The cache key: a new push or another base is another comparison.
export const behindKey = (key, headOid, base) => `${key}@${headOid}@${base}`;

// The compare path, the base's slashes kept as path separators (`release/1.2`).
export function comparePath(repo, headOid, base) {
  const branch = String(base).split("/").map(encodeURIComponent).join("/");
  return `repos/${repo}/compare/${headOid}...${branch}`;
}

export const NO_HEAD_UPDATE = "Couldn't read the head commit of this pull request, so the branch was not updated. Reload it with ⟳ and try again";

// GitHub refuses the update if the branch moved since `headOid` (expected_head_sha), as the merge
// pins its head with --match-head-commit. No `update_method`: GitHub's default, a merge commit.
export function updateArgs(repo, number, headOid) {
  if (!headOid) throw new Error(NO_HEAD_UPDATE);
  return ["api", "-X", "PUT", `repos/${repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${headOid}`];
}

// Whether the selected pull request gets the comparison at all: an open, non-draft pull request
// whose detail is loaded, not opened by a dependency bot (Dependabot and Renovate keep their own
// branches up to date: `@dependabot rebase`).
export function wantsBehind(item, detail) {
  if (!item || item.merged || !detail || !detail.headOid || !detail.base) return false;
  if (detail.isDraft ?? item.isDraft) return false;
  return !isDependencyBot(item.author);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Oct 23", with the year when it is not this year's ("Dec 30, 2025"). Local time.
export function dayLabel(iso, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const text = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? text : `${text}, ${d.getFullYear()}`;
}

// The header's line about it: "15 commits behind staging · last commit Oct 23", or null when the
// branch is up to date or nothing is known yet. The last commit is when CI last ran on a push.
export function behindLine(behind, base, now = Date.now()) {
  if (!behind || !(behind.count > 0)) return null;
  const n = `${behind.count} ${behind.count === 1 ? "commit" : "commits"} behind ${base}`;
  const day = behind.lastCommitAt ? dayLabel(behind.lastCommitAt, now) : "";
  return day ? `${n} · last commit ${day}` : n;
}

// The Update branch button for the selected pull request, or null when it is not shown: shown only
// when the branch is behind, with no conflicts (GitHub refuses the update then; the header says
// "Has conflicts"). `armed` is this pull request's armed update (or null), `updating` its running one,
// `busy` any other write in progress (a merge, another update).
export function updateView({ item, detail, behind, armed = null, updating = false, busy = false }) {
  if (!wantsBehind(item, detail) || !(behind?.count > 0)) return null;
  if (detail.mergeable === "CONFLICTING") return null;
  const head = detail.head ?? item.head, base = detail.base ?? item.base;
  const stillArmed = Boolean(armed) && armed.headOid === detail.headOid;
  if (updating) return { enabled: false, armed: false, label: "Updating…", note: "Updating the branch…" };
  return {
    enabled: !busy,
    armed: stillArmed && !busy,
    label: stillArmed ? "Confirm update" : "⇣ Update branch",
    note: stillArmed ? `Click again to merge ${base} into ${head} · Esc to cancel` : null,
  };
}
