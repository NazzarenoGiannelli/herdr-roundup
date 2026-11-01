// Pure logic for the action bar: the gh arguments of every write, what the merge button shows,
// and the checks made again right before a merge. Imports only ./rules.js (loaded by Node
// tests and by the Herdr runtime, so no `herdr` import here: `exec` is passed in).

import { defaultMethod, methodChoices, mergeBlock, labelFor, menuLabel } from "./rules.js";
import { DEFAULT_CONFIG } from "./config.js";

const FLAGS = { squash: "--squash", merge: "--merge", rebase: "--rebase" };
const NAMES = { squash: "squash", merge: "merge commit", rebase: "rebase" };

export const methodName = (method) => NAMES[method] ?? String(method);
export const refText = (item) => `${item.repo}#${item.number}`;

// --- gh arguments (every write goes through these; the tests pin them) -----------------------

export const readyArgs = (repo, number) => ["pr", "ready", String(number), "--repo", repo];

// Never --admin, --auto or --delete-branch (branch deletion is the repository's setting).
// Always --match-head-commit: GitHub refuses the merge if the branch moved since `headOid`. Without
// that commit there is no merge at all (the panel stops earlier, see preflight; this is the backstop).
export const NO_HEAD_MESSAGE = "Couldn't read the head commit of this pull request, so nothing was merged. Reload it with ⟳ and try again";
export function mergeArgs(repo, number, method, headOid) {
  const flag = FLAGS[method];
  if (!flag) throw new Error(`Unknown merge method: ${method}`);
  if (!headOid) throw new Error(NO_HEAD_MESSAGE);
  return ["pr", "merge", String(number), "--repo", repo, flag, "--match-head-commit", headOid];
}

export function commentArgs(kind, repo, number, body) {
  if (kind !== "pr" && kind !== "issue") throw new Error(`Unknown kind: ${kind}`);
  return [kind, "comment", String(number), "--repo", repo, "--body", body];
}

// The steps of a merge: a draft is marked ready first.
export function mergePlan(repo, number, method, { draft, headOid } = {}) {
  const plan = [{ step: "merge", args: mergeArgs(repo, number, method, headOid) }];
  if (draft) plan.unshift({ step: "ready", args: readyArgs(repo, number) });
  return plan;
}

// Runs the steps through `exec("gh", args)` in order. `dry`: logs each command instead.
// Rejects with gh's own message; a merge that fails after the draft was marked ready says so.
export async function runPlan(plan, { exec, dry = false, log = () => {} }) {
  let marked = false;
  for (const { step, args } of plan) {
    if (dry) { log(`gh ${args.join(" ")}`); continue; }
    const r = await exec("gh", args);
    if (r.code !== 0) {
      const text = String(r.stderr || "").trim() || String(r.stdout || "").trim() || `gh exited with code ${r.code}`;
      throw new Error(marked && step === "merge" ? `Marked ready, but the merge failed: ${text}` : text);
    }
    if (step === "ready") marked = true;
  }
}

// A confirm that arrives right after arming is a double-click (or a bounced button), not a decision.
export const CONFIRM_DELAY_MS = 500;
export const canConfirm = (armed, now, delay = CONFIRM_DELAY_MS) =>
  Boolean(armed) && Number.isFinite(armed.armedAt) && now - armed.armedAt >= delay;

// The refs the default method and the repository lookup are computed from: the loaded detail's
// (fresh) head and base, the list item's only until the detail is there (the list can be a minute old).
export function effectiveRef(item, detail) {
  return { head: detail?.head ?? item.head ?? null, base: detail?.base ?? item.base ?? null };
}
export const repoKey = (item, detail) => `${item.repo}:${effectiveRef(item, detail).base}`;

// --- the merge button -------------------------------------------------------------------------

// How the button looks, as on GitHub: green when the PR can go in as it is, grey when it is a
// draft (it still works: confirming marks it ready first), dimmed when nothing can be done.
// "armed" is our own confirm step. Returns "green" | "neutral" | "armed" | "off".
export function buttonTone(v) {
  if (!v.enabled) return "off";
  if (v.armed) return "armed";
  return v.draft ? "neutral" : "green";
}

// What the button shows, from what is known. Inputs: `item` (the list's PR), `detail` (the loaded
// detail, or null), `repo` (fetchRepo's result for the effective base, see repoKey, or null), the pick for this PR (or null), the
// armed snapshot of this PR (or null) and the person's `config` (its stagingFlow decides the default method). Its `ci` is the detail's rollup state (the list's state
// only until the detail is there).
// status: "loading" | "blocked" | "choose" | "ready". Only "ready" is clickable.
export function mergeView({ item, detail, repo, repoError = null, detailError = null, picked = null, armed = null, merging = false, config = DEFAULT_CONFIG }) {
  const draft = Boolean(detail?.isDraft ?? item.isDraft);
  const eff = effectiveRef(item, detail);
  const out = { status: "loading", reason: null, method: null, prHead: eff.head, prBase: eff.base, draft, label: "Merge", choices: [], enabled: false, armed: false, merging: Boolean(merging) };
  if (!repo) {
    return repoError
      ? { ...out, status: "blocked", reason: `Couldn't read this repository's merge settings: ${repoError}` }
      : { ...out, reason: "Checking merge settings…" };
  }
  if (!detail) {
    return detailError
      ? { ...out, status: "blocked", reason: `Couldn't load the pull request: ${detailError}` }
      : { ...out, reason: "Checking the pull request…" };
  }
  const choices = methodChoices(repo.settings, repo.allowedByRules);
  const allowed = (m) => choices.find((c) => c.method === m)?.enabled === true;
  const dflt = defaultMethod({ head: eff.head, base: eff.base }, repo, config);
  // The default is never swapped for another method on its own (a back-merge must not turn into a squash).
  const method = picked && allowed(picked) ? picked : allowed(dflt) ? dflt : null;
  const marked = choices.map((c) => ({ ...c, current: c.method === method }));
  const plain = (m) => labelFor(m, { confirm: false, draft });
  const block = mergeBlock({ ci: detail.ci ?? item.ci, mergeable: detail.mergeable, mergeState: detail.mergeState, checks: detail.checks });
  const base = { ...out, draft, choices: marked, method, label: method ? plain(method) : "Merge" };
  if (block) return { ...base, status: "blocked", reason: block };
  if (!method) {
    const first = choices.find((c) => c.method === dflt);
    return { ...base, status: "choose", reason: choices.some((c) => c.enabled)
      ? `${menuLabel(dflt)} isn't available here (${String(first?.reason ?? "not allowed").toLowerCase()}). Pick another method with ▾`
      : "No merge method is allowed on this branch" };
  }
  // Armed only while the label the person confirmed is still what the button says.
  const stillArmed = Boolean(armed) && armed.method === method && armed.draft === draft && armed.base === eff.base && armed.head === eff.head;
  return { ...base, status: "ready", enabled: true, armed: stillArmed, label: labelFor(method, { confirm: stillArmed, draft }) };
}

// The re-check before merging, on the freshly loaded detail: a reason to abort, or null.
// Fields the detail does not carry are not treated as a change.
export function preflight(armed, fresh, item) {
  const block = mergeBlock({ ci: fresh.ci ?? item.ci, mergeable: fresh.mergeable, mergeState: fresh.mergeState, checks: fresh.checks });
  if (block) return block;
  if (!fresh.headOid) return NO_HEAD_MESSAGE; // a merge is never run without --match-head-commit
  if (fresh.isDraft != null && fresh.isDraft !== armed.draft) {
    return armed.draft ? "It is no longer a draft. Check the button and confirm again" : "It was turned back into a draft. Check the button and confirm again";
  }
  if (fresh.headOid && armed.headOid && fresh.headOid !== armed.headOid) return "New commits were pushed after you armed the button. Check them and confirm again";
  if (fresh.base && armed.base && fresh.base !== armed.base) return "The base branch changed. Check the button and confirm again";
  if (fresh.head && armed.head && fresh.head !== armed.head) return "The head branch changed. Check the button and confirm again";
  return null;
}

// --- mergeability that GitHub has not computed yet ------------------------------------------------

export const MERGE_RETRY_MS = 2500;  // wait before looking again
export const MERGE_RETRIES = 2;      // reloads of a detail per item and stamp
export const mergeUnknown = (detail) => detail?.mergeable === "UNKNOWN";
// A loaded detail with mergeable UNKNOWN is reloaded after MERGE_RETRY_MS, `tries` times at most.
export const wantsMergeRetry = (detail, tries) => mergeUnknown(detail) && tries < MERGE_RETRIES;
// The first reload comes soon, the last one later: GitHub can take several seconds after a merge into the base.
export const mergeRetryDelay = (tries) => (tries > 0 ? 10000 : MERGE_RETRY_MS);
// The merge's own re-check waits once only when UNKNOWN is the sole thing in the way (not for a failing CI).
export const onlyUnknownBlocks = (fresh, item) =>
  mergeUnknown(fresh) && mergeBlock({ ci: fresh.ci ?? item.ci, mergeable: null, mergeState: fresh.mergeState }) === null;

// --- comments ---------------------------------------------------------------------------------

// gh takes the body as a command-line argument, and Windows caps the whole line near 32 000 characters.
export const COMMENT_MAX = 30000;
export const commentProblem = (body, max = COMMENT_MAX) => {
  const n = String(body ?? "").length;
  return n > max ? `Comment too long for gh on Windows: ${n}/${max} characters` : null;
};

// --- lists ------------------------------------------------------------------------------------

// The row to select once `key` is gone: the one after it, else the one before, else none.
export function nextKey(keys, key) {
  const i = keys.indexOf(key);
  return i < 0 ? null : keys[i + 1] ?? keys[i - 1] ?? null;
}

// After `merged` (a key) landed on `base`, the other cached PRs of the same repository and base are
// out of date (their mergeability changed): the keys to reload. `baseOf(key)`: that PR's base or null.
export function siblingKeys(keys, merged, base, baseOf) {
  const repoOf = (k) => k.slice(0, k.lastIndexOf("#"));
  return base == null ? [] : keys.filter((k) => k !== merged && repoOf(k) === repoOf(merged) && baseOf(k) === base);
}

// Merged pull requests stay in GitHub's search results for a while: keep them out of a refreshed
// list for `ttl` ms. `gone`: key -> when it was merged; forgotten once expired.
export function dropGone(items, gone, now, ttl) {
  for (const [key, at] of gone) if (now - at >= ttl) gone.delete(key);
  return gone.size === 0 ? items : items.filter((i) => !gone.has(`${i.repo}#${i.number}`));
}

export const ROW_H = 31, ROW_H_REASON = 46, FOOTER_H = 48, MENU_PAD = 12;
// Height of the merge popup: one row per method (taller with a reason), the footer, the padding.
export const menuHeight = (choices) => choices.reduce((h, c) => h + (c.reason ? ROW_H_REASON : ROW_H), FOOTER_H + MENU_PAD);
