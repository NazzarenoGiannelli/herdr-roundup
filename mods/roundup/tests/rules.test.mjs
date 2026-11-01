import { test } from "node:test";
import assert from "node:assert/strict";
import {
  botName, isDependencyBot, reviewState, ciFromRollup, views, defaultMethod, methodChoices, mergeBlock, labelFor, menuLabel, chips,
} from "../rules.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../config.js";

const cfg = (raw) => normalizeConfig(raw).config;
const STAGING = cfg({ stagingFlow: true });
const CLAUDE = cfg({ reviewers: ["claude"] }); // the default names no reviewer

const pr = (o = {}) => ({ repo: "acme/widgets", number: 1, isDraft: false, head: "fix/x", base: "staging",
  author: "sam", labels: [], ci: "success", reviewDecision: null, comments: [], ...o });
const claude = (body) => ({ author: "claude", body, createdAt: "2026-10-31T10:00:00Z" });

test("reviewState", () => {
  assert.equal(reviewState(pr(), CLAUDE), "none");
  assert.equal(reviewState(pr({ comments: [claude("Review\nLGTM")] }), CLAUDE), "approved");
  assert.equal(reviewState(pr({ comments: [claude("LGTM"), claude("  CHANGES REQUESTED: fix the test")] }), CLAUDE), "changes");
  assert.equal(reviewState(pr({ reviewDecision: "CHANGES_REQUESTED", comments: [claude("LGTM")] }), CLAUDE), "changes");
  assert.equal(reviewState(pr({ reviewDecision: "APPROVED", comments: [claude("CHANGES REQUESTED")] }), CLAUDE), "approved");
});

test("reviewState: by default nobody is a reviewer, so a comment is not an approval", () => {
  assert.deepEqual(DEFAULT_CONFIG.reviewers, []);
  assert.equal(reviewState(pr({ comments: [claude("Claude finished sam's task")] })), "none");
  assert.equal(reviewState(pr({ comments: [claude("Claude finished sam's task")] }), cfg({})), "none");
  assert.equal(reviewState(pr({ comments: [claude("LGTM")] }), cfg({ reviewers: ["claude"] })), "approved", "naming the reviewer turns it on");
});

test("ciFromRollup", () => {
  assert.equal(ciFromRollup("SUCCESS"), "success");
  assert.equal(ciFromRollup("PENDING"), "pending");
  assert.equal(ciFromRollup("EXPECTED"), "pending");
  assert.equal(ciFromRollup("FAILURE"), "failure");
  assert.equal(ciFromRollup("ERROR"), "failure");
  assert.equal(ciFromRollup(null), "none");
});

test("reviewState: the reviewers come from the config, compared without regard to case", () => {
  const byPriya = (body) => ({ author: "Priya", body, createdAt: "2026-10-31T10:00:00Z" });
  assert.equal(reviewState(pr({ comments: [byPriya("LGTM")] })), "none", "not a reviewer by default");
  assert.equal(reviewState(pr({ comments: [byPriya("LGTM")] }), cfg({ reviewers: ["priya"] })), "approved");
  assert.equal(reviewState(pr({ comments: [byPriya("CHANGES REQUESTED: no")] }), cfg({ reviewers: ["priya"] })), "changes");
  assert.equal(reviewState(pr({ comments: [claude("LGTM")] }), cfg({ reviewers: ["priya"] })), "none", "only the listed reviewers count");
  assert.equal(reviewState(pr({ comments: [claude("LGTM")] }), cfg({ reviewers: [] })), "none");
  assert.equal(reviewState(pr({ reviewDecision: "APPROVED" }), cfg({ reviewers: [] })), "approved", "GitHub's decision needs no reviewer");
});

test("views: built-in signals", () => {
  assert.deepEqual(views(pr({ isDraft: true })).sort(), ["drafts", "review"]);
  assert.deepEqual(views(pr({ author: "dependabot", comments: [claude("ok")] }), CLAUDE), ["ready", "deps"]);
  assert.deepEqual(views(pr({ author: "renovate" })), ["review", "deps"]);
  assert.deepEqual(views(pr({ ci: "failure", reviewDecision: "APPROVED" })), []);
  assert.deepEqual(views(pr({ ci: "success", reviewDecision: "APPROVED" })), ["ready"]);
  assert.deepEqual(views(pr({ ci: "pending", reviewDecision: "REVIEW_REQUIRED" })), ["review"]);
});

test("views: a dependency bot's PR is in Dependencies by its real GraphQL login, with no label at all", () => {
  const noLabels = cfg({ labels: { deps: [] } });
  for (const author of ["dependabot", "renovate", "app/renovate", "dependabot[bot]", "Renovate[bot]"]) {
    assert.ok(views(pr({ author, labels: [] }), noLabels).includes("deps"), author);
    assert.ok(isDependencyBot(author), author);
  }
  for (const author of ["sam", "dependabot-fan", "renovate-bot", "", null, undefined]) {
    assert.ok(!views(pr({ author, labels: [] }), noLabels).includes("deps"), String(author));
  }
  assert.equal(botName("app/Dependabot[bot]"), "dependabot");
});

test("views: no labels count by default, except dependencies", () => {
  assert.deepEqual(views(pr({ ci: "failure", labels: ["ship-it", "needs-eyes"], reviewDecision: "CHANGES_REQUESTED" })), []);
  assert.deepEqual(views(pr({ ci: "failure", labels: ["dependencies"], reviewDecision: "CHANGES_REQUESTED" })), ["deps"]);
  assert.deepEqual(DEFAULT_CONFIG.labels, { ready: [], review: [], deps: ["dependencies"] });
});

test("views: config.labels add a PR to a view on top of the built-in signals", () => {
  const labels = cfg({ labels: { ready: ["ship-it"], review: ["Needs-Eyes"], deps: ["chore-bump"] } });
  const base = { ci: "failure", reviewDecision: "CHANGES_REQUESTED" }; // none of the built-in signals
  assert.deepEqual(views(pr({ ...base, labels: ["ship-it"] }), labels), ["ready"]);
  assert.deepEqual(views(pr({ ...base, labels: ["needs-eyes"] }), labels), ["review"], "labels are compared without regard to case");
  assert.deepEqual(views(pr({ ...base, labels: ["chore-bump"] }), labels), ["deps"]);
  assert.deepEqual(views(pr({ ...base, labels: ["dependencies"] }), labels), [], "a list in the config replaces the default one");
  assert.deepEqual(views(pr({ isDraft: true, labels: ["ship-it"] }), labels).sort(), ["drafts", "ready", "review"]);
  assert.deepEqual(views(pr({ ci: "success", reviewDecision: "APPROVED" }), labels), ["ready"], "built-in signals still count");
});

test("defaultMethod with the staging flow", () => {
  const staging = { hasStaging: true, lastMethod: null };
  assert.equal(defaultMethod(pr({ head: "main", base: "staging" }), staging, STAGING), "merge");
  assert.equal(defaultMethod(pr({ head: "backmerge/sync-1031", base: "staging" }), staging, STAGING), "merge");
  assert.equal(defaultMethod(pr({ head: "staging", base: "main" }), staging, STAGING), "merge");
  assert.equal(defaultMethod(pr({ head: "fix/x", base: "staging" }), staging, STAGING), "squash");
  assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: false, lastMethod: "merge" }, STAGING), "merge");
  assert.equal(defaultMethod(pr({ head: "feat/y", base: "master" }), { hasStaging: false, lastMethod: null }, STAGING), "squash");
});

test("defaultMethod without the staging flow (the default): the last merged PR's method, else squash", () => {
  for (const config of [undefined, DEFAULT_CONFIG, cfg({ stagingFlow: false })]) {
    // A staging branch changes nothing: history decides for every repository.
    assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: true, lastMethod: "merge" }, config), "merge");
    assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: true, lastMethod: "squash" }, config), "squash");
    assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: true, lastMethod: null }, config), "squash");
    assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: false, lastMethod: "merge" }, config), "merge");
    assert.equal(defaultMethod(pr({ head: "feat/y", base: "develop" }), { lastMethod: "rebase" }, config), "rebase");
    assert.equal(defaultMethod(pr({ head: "feat/y", base: "develop" }), {}, config), "squash");
    // No branch name is special either: a back-merge is only a merge commit when the history says so.
    assert.equal(defaultMethod(pr({ head: "main", base: "staging" }), { hasStaging: true, lastMethod: "squash" }, config), "squash");
    assert.equal(defaultMethod(pr({ head: "backmerge/sync-1031", base: "develop" }), { lastMethod: null }, config), "squash");
    assert.equal(defaultMethod(pr({ head: "staging", base: "main" }), { hasStaging: true, lastMethod: "merge" }, config), "merge");
  }
});

test("methodChoices", () => {
  assert.deepEqual(methodChoices({ squash: true, merge: true, rebase: false }, ["merge"]).map((c) => [c.method, c.enabled]),
    [["squash", false], ["merge", true], ["rebase", false]]);
  assert.equal(methodChoices({ squash: true, merge: true, rebase: false }, null)[2].reason, "Disabled in this repository's settings");
  assert.equal(methodChoices({ squash: true, merge: true, rebase: true }, ["merge"])[0].reason, "Not allowed on this branch");
  assert.equal(methodChoices({ squash: true, merge: true, rebase: true }, null)[0].reason, null);
});

test("mergeBlock", () => {
  assert.equal(mergeBlock({ ci: "pending", mergeable: "MERGEABLE", mergeState: "CLEAN" }), "CI is still running");
  assert.equal(mergeBlock({ ci: "success", mergeable: "CONFLICTING", mergeState: "DIRTY" }), "Has conflicts");
  assert.equal(mergeBlock({ ci: "success", mergeable: "MERGEABLE", mergeState: "CLEAN" }), null);
  assert.equal(mergeBlock({ ci: "failure", mergeable: "MERGEABLE", mergeState: "CLEAN" }), "CI is failing");
  assert.equal(mergeBlock({ ci: "success", mergeable: "UNKNOWN", mergeState: "UNKNOWN" }), "GitHub hasn't computed mergeability yet, try ⟳ in a moment");
  assert.equal(mergeBlock({ ci: "success", mergeable: "MERGEABLE", mergeState: "BLOCKED" }), "Blocked by branch protection");
});

test("labelFor", () => {
  assert.equal(labelFor("squash", { confirm: false, draft: false }), "Squash and merge");
  assert.equal(labelFor("squash", { confirm: true, draft: false }), "Confirm squash and merge");
  assert.equal(labelFor("merge", { confirm: true, draft: false }), "Confirm merge");
  assert.equal(labelFor("squash", { confirm: true, draft: true }), "Confirm mark ready and squash and merge");
  assert.equal(labelFor("squash", { confirm: false, draft: true }), "Mark ready and squash and merge");
  assert.equal(labelFor("merge", { confirm: false, draft: true }), "Mark ready and merge");
  assert.equal(labelFor("merge", { confirm: false, draft: false }), "Merge pull request");
  assert.equal(menuLabel("merge"), "Create a merge commit");
  assert.equal(menuLabel("squash"), "Squash and merge");
  assert.equal(menuLabel("rebase"), "Rebase and merge");
  assert.equal(labelFor("rebase", { confirm: true, draft: true }), "Confirm mark ready and rebase and merge");
  assert.equal(labelFor("rebase", { confirm: false, draft: false }), "Rebase and merge");
  assert.equal(labelFor("rebase", { confirm: true, draft: false }), "Confirm rebase and merge");
  assert.equal(labelFor("merge", { confirm: true, draft: true }), "Confirm mark ready and merge");
});

test("chips", () => {
  assert.deepEqual(chips([{ repo: "a/gadgets" }, { repo: "a/widgets" }, { repo: "a/widgets" }]),
    [{ repo: "a/widgets", count: 2 }, { repo: "a/gadgets", count: 1 }]);
  assert.deepEqual(chips([{ repo: "b" }, { repo: "a" }]), [{ repo: "a", count: 1 }, { repo: "b", count: 1 }]);
});

test("defaultMethod: back-merges and releases are merge commits with or without a staging branch", () => {
  const noStaging = { hasStaging: false, lastMethod: null };
  const noHistory = { hasStaging: false };
  for (const repo of [noStaging, noHistory, { hasStaging: false, lastMethod: "squash" }, { hasStaging: true, lastMethod: null }]) {
    assert.equal(defaultMethod(pr({ head: "main", base: "staging" }), repo, STAGING), "merge");
    assert.equal(defaultMethod(pr({ head: "backmerge/sync-1031", base: "staging" }), repo, STAGING), "merge");
    assert.equal(defaultMethod(pr({ head: "backmerge/sync-1031", base: "develop" }), repo, STAGING), "merge");
    assert.equal(defaultMethod(pr({ head: "staging", base: "main" }), repo, STAGING), "merge");
  }
  // The rest is unchanged: history decides without staging, base main is a release only with it.
  assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), noStaging, STAGING), "squash");
  assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: false, lastMethod: "merge" }, STAGING), "merge");
  assert.equal(defaultMethod(pr({ head: "feat/y", base: "main" }), { hasStaging: true }, STAGING), "merge");
  assert.equal(defaultMethod(pr({ head: "feat/y", base: "staging" }), { hasStaging: true }, STAGING), "squash");
  assert.equal(defaultMethod(pr({ head: null, base: "staging" }), { hasStaging: true }, STAGING), "squash");
});
