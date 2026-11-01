import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeArgs, readyArgs, commentArgs, mergePlan, runPlan, mergeView, buttonTone, preflight, nextKey, dropGone, refText, menuHeight, methodName, canConfirm, effectiveRef, repoKey,
  MERGE_RETRY_MS, MERGE_RETRIES, mergeRetryDelay, mergeUnknown, wantsMergeRetry, onlyUnknownBlocks, COMMENT_MAX, commentProblem, siblingKeys,
} from "../actions-logic.js";
import { normalizeConfig } from "../config.js";

const STAGING = normalizeConfig({ stagingFlow: true }).config;

const item = (o = {}) => ({ repo: "acme/widgets", number: 130, isDraft: false, head: "fix/x", base: "staging", ci: "success", ...o });
const detail = (o = {}) => ({ mergeable: "MERGEABLE", mergeState: "CLEAN", ci: "success", isDraft: false, headOid: "aaa", head: "fix/x", base: "staging", ...o });
const repo = (o = {}) => ({ settings: { squash: true, merge: true, rebase: true }, hasStaging: true, lastMethod: null, allowedByRules: ["squash", "merge"], ...o });
// These tests are about the staging flow's rules unless they say otherwise.
const view = (o = {}) => mergeView({ item: item(), detail: detail(), repo: repo(), picked: null, armed: null, merging: false, config: STAGING, ...o });

test("mergeView without the staging flow: the repository's last method, else squash, whatever the branches are", () => {
  const plain = (o) => view({ config: undefined, ...o });
  assert.equal(plain().method, "squash", "no history: squash");
  assert.equal(plain({ repo: repo({ lastMethod: "merge" }) }).method, "merge", "the last PR into this base was a merge commit");
  assert.equal(plain({ item: item({ base: "main" }), detail: detail({ base: "main" }), repo: repo({ lastMethod: null, allowedByRules: null }) }).method, "squash", "main is not a release without the flow");
  const back = { item: item({ head: "main", base: "staging" }), detail: detail({ head: "main", base: "staging" }) };
  assert.equal(plain({ ...back, repo: repo({ lastMethod: "squash" }) }).method, "squash", "a back-merge is no special case without the flow");
  assert.equal(plain({ ...back, repo: repo({ lastMethod: "merge" }) }).method, "merge");
  assert.equal(view({ ...back, config: normalizeConfig({}).config, repo: repo({ lastMethod: null }) }).method, "squash");
});

test("mergeArgs builds the gh arguments, never --admin or --delete-branch", () => {
  assert.deepEqual(mergeArgs("acme/gadgets", 130, "squash", "abc"), ["pr", "merge", "130", "--repo", "acme/gadgets", "--squash", "--match-head-commit", "abc"]);
  assert.deepEqual(mergeArgs("o/r", 5, "merge", "abc"), ["pr", "merge", "5", "--repo", "o/r", "--merge", "--match-head-commit", "abc"]);
  assert.deepEqual(mergeArgs("o/r", 5, "rebase", "abc"), ["pr", "merge", "5", "--repo", "o/r", "--rebase", "--match-head-commit", "abc"]);
  for (const m of ["squash", "merge", "rebase"]) {
    const a = mergeArgs("o/r", 1, m, "abc");
    assert.ok(!a.includes("--admin") && !a.includes("--delete-branch") && !a.includes("--auto"));
  }
  assert.throws(() => mergeArgs("o/r", 1, "bogus", "abc"), /Unknown merge method/);
});

test("mergeArgs always pins the head commit and refuses to build a merge without one", () => {
  assert.deepEqual(mergeArgs("o/r", 5, "squash", "abc123"), ["pr", "merge", "5", "--repo", "o/r", "--squash", "--match-head-commit", "abc123"]);
  for (const missing of [undefined, null, ""]) assert.throws(() => mergeArgs("o/r", 5, "squash", missing), /head commit/);
});

test("mergePlan without a head commit throws before any step, a draft's mark-ready included", async () => {
  assert.throws(() => mergePlan("o/r", 1, "squash", { draft: true }), /head commit/);
  assert.throws(() => mergePlan("o/r", 1, "merge", { draft: false, headOid: null }), /head commit/);
  let calls = 0;
  try { await runPlan(mergePlan("o/r", 1, "squash", { draft: true }), { exec: async () => { calls++; return { code: 0 }; } }); } catch { /* expected */ }
  assert.equal(calls, 0);
});

test("readyArgs and commentArgs", () => {
  assert.deepEqual(readyArgs("o/r", 7), ["pr", "ready", "7", "--repo", "o/r"]);
  assert.deepEqual(commentArgs("pr", "o/r", 7, "- hi\nthere"), ["pr", "comment", "7", "--repo", "o/r", "--body", "- hi\nthere"]);
  assert.deepEqual(commentArgs("issue", "o/r", 8, "x"), ["issue", "comment", "8", "--repo", "o/r", "--body", "x"]);
  assert.throws(() => commentArgs("other", "o/r", 1, "x"), /kind/);
});

test("mergePlan: a draft is marked ready first, in one plan", () => {
  assert.deepEqual(mergePlan("o/r", 1, "squash", { draft: false, headOid: "abc" }).map((s) => s.args[1]), ["merge"]);
  const plan = mergePlan("o/r", 1, "merge", { draft: true, headOid: "abc" });
  assert.deepEqual(plan.map((s) => s.args.slice(0, 2).join(" ")), ["pr ready", "pr merge"]);
  assert.deepEqual(plan[1].args.slice(-2), ["--match-head-commit", "abc"]);
});

test("runPlan: dry run logs and never calls exec", async () => {
  const log = []; let calls = 0;
  await runPlan(mergePlan("o/r", 1, "squash", { draft: true, headOid: "abc" }), { exec: async () => { calls++; return { code: 0 }; }, dry: true, log: (l) => log.push(l) });
  assert.equal(calls, 0);
  assert.deepEqual(log, ["gh pr ready 1 --repo o/r", "gh pr merge 1 --repo o/r --squash --match-head-commit abc"]);
});

test("runPlan: runs gh in order and stops at the first failure with gh's message", async () => {
  const seen = [];
  const fake = async (cmd, args) => { seen.push([cmd, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; };
  await runPlan(mergePlan("o/r", 1, "rebase", { draft: true, headOid: "abc" }), { exec: fake, dry: false });
  assert.deepEqual(seen, ["gh pr ready 1 --repo o/r", "gh pr merge 1 --repo o/r --rebase --match-head-commit abc"]);

  const failing = async (_c, args) => args[1] === "merge" ? { code: 1, stdout: "", stderr: "X Pull request is not mergeable\n" } : { code: 0, stdout: "", stderr: "" };
  await assert.rejects(runPlan(mergePlan("o/r", 1, "squash", { headOid: "abc" }), { exec: failing, dry: false }), (e) => e.message === "X Pull request is not mergeable");
  // The draft was already marked ready when the merge failed: the message says so.
  await assert.rejects(runPlan(mergePlan("o/r", 1, "squash", { draft: true, headOid: "abc" }), { exec: failing, dry: false }),
    (e) => /Marked ready, but the merge failed: X Pull request is not mergeable/.test(e.message));
  const silent = async () => ({ code: 4, stdout: "", stderr: "" });
  await assert.rejects(runPlan(mergePlan("o/r", 1, "squash", { headOid: "abc" }), { exec: silent, dry: false }), /gh exited with code 4/);
});

test("mergeView: a feature PR to staging defaults to squash, idle label", () => {
  const v = view();
  assert.equal(v.status, "ready");
  assert.equal(v.method, "squash");
  assert.equal(v.label, "Squash and merge");
  assert.equal(v.enabled, true);
  assert.equal(v.reason, null);
  assert.deepEqual(v.choices.map((c) => [c.method, c.enabled, c.current]), [["squash", true, true], ["merge", true, false], ["rebase", false, false]]);
});

test("mergeView: a back-merge defaults to a merge commit, never squash", () => {
  const v = view({ item: item({ head: "main", base: "staging" }), detail: detail({ head: "main", base: "staging" }) });
  assert.equal(v.method, "merge");
  assert.equal(v.label, "Merge pull request");
});

test("mergeView: a pick wins over the default, only when allowed", () => {
  assert.equal(view({ picked: "merge" }).method, "merge");
  assert.equal(view({ picked: "rebase" }).method, "squash", "rebase is not allowed on staging, so the pick is ignored");
});

test("mergeView: armed label states the confirm; a draft says 'Confirm mark ready and'", () => {
  const armed = { key: "acme/widgets#130", method: "squash", draft: false, headOid: "aaa", head: "fix/x", base: "staging" };
  assert.equal(view({ armed }).label, "Confirm squash and merge");
  assert.equal(view({ armed }).armed, true);
  const draft = view({ item: item({ isDraft: true }), detail: detail({ isDraft: true }), armed: { ...armed, draft: true } });
  assert.equal(draft.label, "Confirm mark ready and squash and merge");
  assert.equal(draft.armed, true);
});

test("mergeView: an armed state that no longer matches what the label stated is not armed", () => {
  const armed = { key: "k", method: "squash", draft: false, headOid: "aaa", head: "fix/x", base: "staging" };
  assert.equal(view({ armed, picked: "merge" }).armed, false);
  assert.equal(view({ armed, detail: detail({ isDraft: true }) }).armed, false);
  assert.equal(view({ armed, detail: detail({ ci: "failure" }) }).armed, false, "blocked: nothing to confirm");
});

test("mergeView: a draft with green CI is NOT blocked", () => {
  const v = view({ item: item({ isDraft: true }), detail: detail({ isDraft: true, mergeState: "DRAFT" }) });
  assert.equal(v.enabled, true);
  assert.equal(v.draft, true);
  assert.equal(v.label, "Mark ready and squash and merge", "a draft says it will be marked ready before the first click");
});

test("buttonTone: green when it can go in, grey for a draft, dimmed when blocked, amber when armed", () => {
  assert.equal(buttonTone(view()), "green");
  assert.equal(buttonTone(view({ item: item({ isDraft: true }), detail: detail({ isDraft: true }) })), "neutral");
  assert.equal(buttonTone(view({ detail: detail({ ci: "failure" }) })), "off");
  assert.equal(buttonTone(view({ detail: detail({ ci: "pending" }) })), "off");
  const armed = { key: "k", method: "squash", draft: false, headOid: "aaa", head: "fix/x", base: "staging" };
  assert.equal(buttonTone(view({ armed })), "armed");
  assert.equal(buttonTone({ enabled: false, armed: false, draft: false }), "off");
});

test("mergeView: blocked shows mergeBlock's text and disables the button", () => {
  assert.deepEqual([view({ detail: detail({ ci: "failure" }) }).reason, view({ detail: detail({ ci: "failure" }) }).enabled], ["CI is failing", false]);
  assert.equal(view({ detail: detail({ ci: "pending" }) }).reason, "CI is still running");
  assert.equal(view({ detail: detail({ mergeable: "CONFLICTING" }) }).reason, "Has conflicts");
  const b = view({ detail: detail({ mergeState: "BLOCKED" }) });
  assert.equal(b.status, "blocked");
  assert.equal(b.reason, "Blocked by branch protection");
  assert.equal(b.label, "Squash and merge", "the label stays, greyed out");
});

test("mergeView: ci comes from the loaded detail, the list's ci before that is not used for a decision", () => {
  assert.equal(view({ item: item({ ci: "failure" }), detail: detail({ ci: "success" }) }).enabled, true);
  assert.equal(view({ item: item({ ci: "success" }), detail: detail({ ci: undefined }) }).enabled, true, "falls back to the list's state");
  assert.equal(view({ item: item({ ci: "failure" }), detail: detail({ ci: undefined }) }).reason, "CI is failing");
});

test("mergeView: loading and failed lookups say so, and are not mergeable", () => {
  assert.equal(view({ repo: null }).status, "loading");
  assert.equal(view({ repo: null }).enabled, false);
  assert.match(view({ repo: null, repoError: "boom" }).reason, /Couldn't read this repository's merge settings: boom/);
  assert.equal(view({ detail: null }).status, "loading");
  assert.match(view({ detail: null, detailError: "nope" }).reason, /Couldn't load the pull request: nope/);
});

test("mergeView: a default the repository does not allow is not silently replaced", () => {
  // back-merge to staging, but merge commits are off: never fall back to squash on its own
  const v = view({ item: item({ head: "main", base: "staging" }), detail: detail({ head: "main", base: "staging" }), repo: repo({ settings: { squash: true, merge: false, rebase: false }, allowedByRules: null }) });
  assert.equal(v.method, null);
  assert.equal(v.status, "choose");
  assert.equal(v.enabled, false);
  assert.match(v.reason, /Create a merge commit/);
  assert.match(v.reason, /▾/);
  // picking squash explicitly is allowed
  assert.equal(view({ item: item({ head: "main", base: "staging" }), detail: detail({ head: "main", base: "staging" }), repo: repo({ settings: { squash: true, merge: false, rebase: false }, allowedByRules: null }), picked: "squash" }).method, "squash");
  const none = view({ repo: repo({ settings: { squash: false, merge: false, rebase: false } }) });
  assert.equal(none.reason, "No merge method is allowed on this branch");
});

test("mergeView: a release to main only offers the merge commit", () => {
  const v = view({ item: item({ head: "staging", base: "main" }), detail: detail({ head: "staging", base: "main" }), repo: repo({ allowedByRules: ["merge"] }) });
  assert.equal(v.method, "merge");
  assert.deepEqual(v.choices.map((c) => c.enabled), [false, true, false]);
  assert.equal(v.choices[0].reason, "Not allowed on this branch");
});

test("preflight: aborts with a reason when the PR changed since it was armed", () => {
  const armed = { method: "squash", draft: false, headOid: "aaa", head: "fix/x", base: "staging" };
  assert.equal(preflight(armed, detail(), item()), null);
  assert.match(preflight(armed, detail({ ci: "failure" }), item()), /CI is failing/);
  assert.match(preflight(armed, detail({ mergeable: "CONFLICTING" }), item()), /Has conflicts/);
  assert.match(preflight(armed, detail({ isDraft: true }), item()), /turned back into a draft/);
  assert.match(preflight({ ...armed, draft: true }, detail({ isDraft: false }), item()), /no longer a draft/);
  assert.match(preflight(armed, detail({ headOid: "bbb" }), item()), /New commits were pushed/);
  assert.match(preflight(armed, detail({ base: "main" }), item()), /base branch changed/);
  assert.match(preflight(armed, detail({ head: "other" }), item()), /head branch changed/);
  // base and draft state the detail does not carry are not treated as a change
  assert.equal(preflight(armed, detail({ base: null, isDraft: null }), item()), null);
  // but without the head commit there is no merge: the reason is shown in the bar, gh is never called
  assert.match(preflight(armed, detail({ headOid: null }), item()), /head commit/);
  assert.match(preflight({ ...armed, headOid: null }, detail({ headOid: undefined }), item()), /nothing was merged/);
});

test("canConfirm: a confirm within 500 ms of arming (a double-click) is ignored", () => {
  const armed = { armedAt: 1000 };
  assert.equal(canConfirm(armed, 1000), false);
  assert.equal(canConfirm(armed, 1120), false, "the second click of a double-click");
  assert.equal(canConfirm(armed, 1499), false);
  assert.equal(canConfirm(armed, 1500), true);
  assert.equal(canConfirm(armed, 9000), true);
  assert.equal(canConfirm(armed, 900), false, "the clock went backwards");
  assert.equal(canConfirm(null, 9000), false);
  assert.equal(canConfirm({}, 9000), false, "no arming time: not confirmable");
});

test("effectiveRef and repoKey: the detail's head and base win, the list's only before it loads", () => {
  const it = item({ head: "fix/x", base: "staging" });
  assert.deepEqual(effectiveRef(it, null), { head: "fix/x", base: "staging" });
  assert.deepEqual(effectiveRef(it, detail({ head: "staging", base: "main" })), { head: "staging", base: "main" });
  assert.deepEqual(effectiveRef(it, detail({ head: null, base: null })), { head: "fix/x", base: "staging" });
  assert.equal(repoKey(it, null), "acme/widgets:staging");
  assert.equal(repoKey(it, detail({ base: "main" })), "acme/widgets:main");
});

test("mergeView: a PR retargeted staging -> main after the last poll defaults to a merge commit, not squash", () => {
  // The list still says base staging (a minute old); the detail says main.
  const stale = item({ head: "fix/x", base: "staging" });
  const fresh = detail({ head: "fix/x", base: "main" });
  const v = view({ item: stale, detail: fresh, repo: repo({ allowedByRules: ["merge"] }) });
  assert.equal(v.method, "merge");
  assert.equal(v.label, "Merge pull request");
  assert.equal(v.prBase, "main");
  assert.equal(v.status, "ready");
  // the reverse: the list says main, the detail says staging -> squash
  assert.equal(view({ item: item({ base: "main" }), detail: detail({ base: "staging" }) }).method, "squash");
  // a back-merge decided from the detail's head
  assert.equal(view({ item: item({ head: "fix/x", base: "staging" }), detail: detail({ head: "main", base: "staging" }) }).method, "merge");
});

test("mergeView: before the detail is there, there is nothing to click (no default from the list)", () => {
  const v = view({ item: item({ base: "staging" }), detail: null });
  assert.equal(v.status, "loading");
  assert.equal(v.enabled, false);
});

test("mergeView: armed on the old base is no longer armed once the detail reports another base", () => {
  const armed = { key: "k", method: "merge", draft: false, headOid: "aaa", head: "fix/x", base: "staging" };
  assert.equal(view({ armed, picked: "merge" }).armed, true);
  assert.equal(view({ armed, picked: "merge", detail: detail({ base: "main" }), repo: repo({ allowedByRules: ["merge"] }) }).armed, false);
});

test("preflight: a base that changed after arming aborts, also when the item's base differs from the detail's", () => {
  const stale = item({ head: "fix/x", base: "staging" });
  const v = view({ item: stale, detail: detail({ head: "fix/x", base: "main" }), repo: repo({ allowedByRules: ["merge"] }) });
  const armed = { key: "k", method: v.method, draft: v.draft, headOid: "aaa", head: v.prHead, base: v.prBase };
  assert.equal(armed.base, "main", "armed from the detail, not the list");
  assert.equal(preflight(armed, detail({ head: "fix/x", base: "main" }), stale), null);
  assert.match(preflight(armed, detail({ head: "fix/x", base: "staging" }), stale), /base branch changed/);
});

test("nextKey: the row after the merged one, else the one before, else none", () => {
  assert.equal(nextKey(["a", "b", "c"], "b"), "c");
  assert.equal(nextKey(["a", "b", "c"], "c"), "b");
  assert.equal(nextKey(["a"], "a"), null);
  assert.equal(nextKey(["a", "b"], "zzz"), null);
});

test("dropGone hides merged PRs that the search index still lists, for a while", () => {
  const items = [{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }];
  const gone = new Map([["o/r#1", 1000]]);
  assert.deepEqual(dropGone(items, gone, 2000, 5000).map((i) => i.number), [2]);
  assert.deepEqual(dropGone(items, gone, 9000, 5000).map((i) => i.number), [1, 2]);
  assert.equal(gone.size, 0, "expired entries are forgotten");
});

test("refText, methodName and menuHeight", () => {
  assert.equal(refText({ repo: "o/r", number: 9 }), "o/r#9");
  assert.equal(methodName("merge"), "merge commit");
  assert.equal(methodName("squash"), "squash");
  assert.ok(menuHeight([{ reason: null }, { reason: null }, { reason: "x" }]) > menuHeight([{ reason: null }, { reason: null }, { reason: null }]));
});

test("an UNKNOWN mergeability is retried a bounded number of times", () => {
  assert.equal(MERGE_RETRY_MS, 2500);
  assert.equal(MERGE_RETRIES, 2);
  const unknown = detail({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" });
  assert.equal(mergeUnknown(unknown), true);
  assert.equal(mergeUnknown(detail()), false);
  assert.equal(mergeUnknown(null), false);
  assert.equal(wantsMergeRetry(unknown, 0), true);
  assert.equal(wantsMergeRetry(unknown, 1), true);
  assert.equal(wantsMergeRetry(unknown, 2), false, "two retries at most");
  assert.equal(wantsMergeRetry(detail(), 0), false);
  assert.equal(wantsMergeRetry(detail({ mergeable: "CONFLICTING" }), 0), false);
  assert.equal(wantsMergeRetry(null, 0), false);
});

test("the merge's re-check waits only when UNKNOWN is the sole blocker", () => {
  const unknown = detail({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" });
  assert.equal(onlyUnknownBlocks(unknown, item()), true);
  assert.equal(onlyUnknownBlocks({ ...unknown, ci: "failure" }, item()), false);
  assert.equal(onlyUnknownBlocks({ ...unknown, ci: "pending" }, item()), false);
  assert.equal(onlyUnknownBlocks({ ...unknown, mergeState: "BLOCKED" }, item()), false);
  assert.equal(onlyUnknownBlocks(detail(), item()), false);
  assert.equal(onlyUnknownBlocks({ ...unknown, ci: undefined }, item({ ci: "success" })), true);
});

test("an UNKNOWN mergeability stops preflight and the button with the retry hint", () => {
  const armed = { method: "squash", draft: false, headOid: "aaa", head: "fix/x", base: "staging" };
  const unknown = detail({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" });
  assert.equal(preflight(armed, unknown, item()), "GitHub hasn't computed mergeability yet, try ⟳ in a moment");
  const v = view({ detail: unknown });
  assert.equal(v.status, "blocked");
  assert.ok(v.reason.endsWith(", try ⟳ in a moment"));
});

test("commentProblem refuses a comment over 30 000 characters, naming the count", () => {
  assert.equal(COMMENT_MAX, 30000);
  assert.equal(commentProblem("x".repeat(30000)), null);
  assert.equal(commentProblem("x".repeat(30001)), "Comment too long for gh on Windows: 30001/30000 characters");
  assert.equal(commentProblem("x".repeat(45123)), "Comment too long for gh on Windows: 45123/30000 characters");
  assert.equal(commentProblem(""), null);
  assert.equal(commentProblem(undefined), null);
});

test("siblingKeys: other cached PRs of the same repository and base", () => {
  const bases = { "acme/widgets#1": "staging", "acme/widgets#2": "staging", "acme/widgets#3": "main",
    "acme/widgets#4": null, "acme/gizmos#2": "staging", "acme/widgets#12": "staging" };
  const keys = Object.keys(bases), baseOf = (k) => bases[k];
  assert.deepEqual(siblingKeys(keys, "acme/widgets#1", "staging", baseOf), ["acme/widgets#2", "acme/widgets#12"]);
  assert.deepEqual(siblingKeys(keys, "acme/widgets#3", "main", baseOf), []);
  assert.deepEqual(siblingKeys(keys, "acme/widgets#1", null, baseOf), []);
});

test("UNKNOWN retries: the first soon, the last later", () => {
  assert.equal(mergeRetryDelay(0), MERGE_RETRY_MS);
  assert.equal(mergeRetryDelay(1), 10000);
});
