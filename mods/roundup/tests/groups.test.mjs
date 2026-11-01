// Task B: the list grouped by whose move it is, and the merge note that names the checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, GROUP_IDS, checkNames, mergeBlock } from "../rules.js";
import { GROUPS, HEADING_H, isHeading, groupRows, selectable, rowIndex, keyOf, stableOrder, ROW_H } from "../browse.js";
import { mergeView, preflight, nextKey } from "../actions-logic.js";
import { normalizeConfig } from "../config.js";

const cfg = (raw) => normalizeConfig(raw).config;
const pr = (n, o = {}) => ({ repo: "acme/widgets", number: n, isDraft: false, head: "fix/x", base: "main",
  author: "sam", labels: [], ci: "success", reviewDecision: null, comments: [], updatedAt: "2026-01-01T00:00:00Z", ...o });
const group = (o, config) => groupOf(pr(1, o), config);

// --- groupOf: whose move it is ---------------------------------------------------------------------

test("groupOf: ready, to review, needs fixing, waiting, drafts", () => {
  assert.equal(group({ ci: "success", reviewDecision: "APPROVED" }), "ready");
  assert.equal(group({ ci: "success", reviewDecision: null }), "review");
  assert.equal(group({ ci: "success", reviewDecision: "REVIEW_REQUIRED" }), "review");
  assert.equal(group({ ci: "none", reviewDecision: null }), "review", "no CI at all: still waiting for a review");
  assert.equal(group({ ci: "failure" }), "fixing");
  assert.equal(group({ ci: "success", reviewDecision: "CHANGES_REQUESTED" }), "fixing");
  assert.equal(group({ ci: "pending", reviewDecision: "APPROVED" }), "waiting");
  assert.equal(group({ isDraft: true }), "drafts");
});

test("groupOf: first match wins, drafts always last", () => {
  assert.equal(group({ isDraft: true, ci: "success", reviewDecision: "APPROVED" }), "drafts", "a draft is never ready");
  assert.equal(group({ isDraft: true, ci: "failure" }), "drafts");
  assert.equal(group({ ci: "pending", reviewDecision: null }), "review", "CI running but unreviewed: the reviewer is not waiting for CI");
  assert.equal(group({ ci: "failure", reviewDecision: null }), "fixing", "failing CI beats 'to review'");
  assert.equal(group({ ci: "pending", reviewDecision: "CHANGES_REQUESTED" }), "fixing", "changes requested beats 'waiting'");
  assert.equal(group({ ci: "failure", reviewDecision: "APPROVED" }), "fixing");
});

test("groupOf: a configured reviewer's comment counts as the review", () => {
  const reviewed = (body) => [{ author: "claude", body, createdAt: "2026-01-01T00:00:00Z" }];
  const claude = cfg({ reviewers: ["claude"] });
  assert.equal(group({ ci: "success", comments: reviewed("Looks good") }, claude), "ready");
  assert.equal(group({ ci: "success", comments: reviewed("CHANGES REQUESTED: fix it") }, claude), "fixing");
  assert.equal(group({ ci: "success", comments: reviewed("Looks good") }), "review", "nobody is a reviewer by default");
  assert.equal(group({ ci: "success", comments: reviewed("Looks good") }, cfg({ reviewers: ["priya"] })), "review", "not a configured reviewer");
});

test("groupOf: a ready label puts a PR in Ready to merge; an approved PR with no CI is ready too", () => {
  const ready = cfg({ labels: { ready: ["ship-it"] } });
  assert.equal(group({ labels: ["ship-it"], ci: "success", reviewDecision: null }, ready), "ready");
  assert.equal(group({ labels: ["Ship-It"], ci: "pending" }, ready), "ready", "the label compare ignores case");
  assert.equal(group({ labels: ["ship-it"], ci: "success" }), "review", "the label means nothing without the config");
  assert.equal(group({ labels: ["ship-it"], isDraft: true }, ready), "drafts");
  assert.equal(group({ ci: "none", reviewDecision: "APPROVED" }), "ready", "nothing left to wait for");
});

test("groupOf: every PR lands in exactly one known group", () => {
  for (const ci of ["success", "failure", "pending", "none"]) for (const reviewDecision of [null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]) for (const isDraft of [false, true]) {
    assert.ok(GROUP_IDS.includes(group({ ci, reviewDecision, isDraft })), `${ci} ${reviewDecision} ${isDraft}`);
  }
});

// --- groupRows -------------------------------------------------------------------------------------

const mix = () => [
  pr(1, { ci: "success", reviewDecision: null }),             // review
  pr(2, { isDraft: true }),                                   // drafts
  pr(3, { ci: "success", reviewDecision: "APPROVED" }),       // ready
  pr(4, { ci: "failure" }),                                   // fixing
  pr(5, { ci: "success", reviewDecision: null }),             // review
  pr(6, { ci: "pending", reviewDecision: "APPROVED" }),       // waiting
  pr(7, { ci: "success", reviewDecision: "APPROVED" }),       // ready
];
const shape = (rows) => rows.map((r) => isHeading(r) ? `${r.heading} (${r.count})` : r.number);

test("groupRows: headings with counts, groups in order, each keeping the order it had", () => {
  assert.deepEqual(shape(groupRows(mix())), [
    "Ready to merge (2)", 3, 7,
    "To review (2)", 1, 5,
    "Needs fixing (1)", 4,
    "Waiting (1)", 6,
    "Drafts (1)", 2,
  ]);
});

test("groupRows: empty groups are left out, no PRs no rows", () => {
  assert.deepEqual(shape(groupRows([pr(1, { ci: "failure" })])), ["Needs fixing (1)", 1]);
  assert.deepEqual(groupRows([]), []);
});

test("groupRows: every PR once, nothing lost", () => {
  assert.deepEqual(selectable(groupRows(mix())).map((r) => r.number).sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("groupRows takes the config: a ready label moves a PR up", () => {
  const config = cfg({ labels: { ready: ["ship-it"] } });
  const items = [pr(1, { ci: "success", labels: ["ship-it"] }), pr(2, { ci: "success" })];
  assert.deepEqual(shape(groupRows(items, config)), ["Ready to merge (1)", 1, "To review (1)", 2]);
  assert.deepEqual(shape(groupRows(items)), ["To review (2)", 1, 2]);
});

test("grouped rows keep the stable order across a refresh", () => {
  const order = stableOrder(mix(), null).map(keyOf);
  // The refresh brings the PRs back in another order, and #1 got approved: it moves group, the rest stay put.
  const next = [...mix()].reverse().map((p) => p.number === 1 ? { ...p, reviewDecision: "APPROVED" } : p);
  const rows = groupRows(stableOrder(next, order));
  const ready = selectable(rows).filter((r) => groupOf(r) === "ready").map((r) => r.number);
  assert.deepEqual(ready, order.map((k) => Number(k.split("#")[1])).filter((n) => [1, 3, 7].includes(n)));
});

// --- navigation: headings are never selected --------------------------------------------------------

test("a heading's key cannot be a PR's key", () => {
  const rows = groupRows(mix());
  const keys = rows.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  assert.equal(keyOf(rows[0]), "group:ready");
  assert.equal(keys.filter((k) => k.startsWith("group:")).length, 5);
  assert.ok(keys.filter((k) => !k.startsWith("group:")).every((k) => /^[\w.-]+\/[\w.-]+#\d+$/.test(k)));
});

test("selectable: no headings, in the order ↑/↓ walk; nextKey after a merge stays on a PR", () => {
  const rows = groupRows(mix());
  const flat = selectable(rows);
  assert.ok(flat.every((r) => !isHeading(r)));
  assert.deepEqual(flat.map((r) => r.number), [3, 7, 1, 5, 4, 6, 2]);
  const keys = flat.map(keyOf);
  assert.equal(nextKey(keys, "acme/widgets#7"), "acme/widgets#1", "the last of a group goes on to the next group's first, over the heading");
  assert.equal(nextKey(keys, "acme/widgets#2"), "acme/widgets#6", "the last row goes back to the one before");
});

test("rowIndex counts the headings (the list scrolls by it) and misses cleanly", () => {
  const rows = groupRows(mix());
  assert.equal(rowIndex(rows, "acme/widgets#3"), 1, "after the first heading");
  assert.equal(rowIndex(rows, "acme/widgets#1"), 4, "after two headings and two rows");
  assert.equal(rowIndex(rows, "acme/widgets#99"), -1);
  assert.equal(rowIndex(rows, null), -1);
});

test("the five groups, and a heading is shorter than a row", () => {
  assert.deepEqual(GROUPS.map((g) => g.label), ["Ready to merge", "To review", "Needs fixing", "Waiting", "Drafts"]);
  assert.deepEqual(GROUPS.map((g) => g.id), GROUP_IDS);
  assert.ok(HEADING_H < ROW_H);
});

// --- the merge note names the checks ----------------------------------------------------------------

const chk = (name, state) => ({ name, state });

test("mergeBlock: failing CI names the failing checks, three at most", () => {
  const base = { mergeable: "MERGEABLE", mergeState: "BLOCKED", ci: "failure" };
  assert.equal(mergeBlock({ ...base, checks: [chk("test", "failure"), chk("lint", "success"), chk("Boot smoke test", "failure")] }), "CI failing: test, Boot smoke test");
  assert.equal(mergeBlock({ ...base, checks: [chk("a", "failure"), chk("b", "failure"), chk("c", "failure")] }), "CI failing: a, b, c");
  assert.equal(mergeBlock({ ...base, checks: ["a", "b", "c", "d", "e"].map((n) => chk(n, "failure")) }), "CI failing: a, b, c +2 more");
});

test("mergeBlock: running CI names the running checks", () => {
  assert.equal(mergeBlock({ ci: "pending", mergeable: "MERGEABLE", mergeState: "BLOCKED", checks: [chk("test", "success"), chk("e2e", "pending")] }), "CI running: e2e");
});

test("mergeBlock: without loaded checks (or none in that state) it keeps the plain text", () => {
  const base = { mergeable: "MERGEABLE", mergeState: "CLEAN" };
  assert.equal(mergeBlock({ ...base, ci: "failure" }), "CI is failing");
  assert.equal(mergeBlock({ ...base, ci: "failure", checks: null }), "CI is failing", "an issue has no checks");
  assert.equal(mergeBlock({ ...base, ci: "failure", checks: [] }), "CI is failing");
  assert.equal(mergeBlock({ ...base, ci: "failure", checks: [chk("test", "success")] }), "CI is failing", "the rollup says failing but no check does");
  assert.equal(mergeBlock({ ...base, ci: "pending", checks: [chk("test", "success")] }), "CI is still running");
  assert.equal(mergeBlock({ ...base, ci: "success", checks: [chk("test", "failure")] }), null, "the rollup decides whether CI blocks");
});

test("mergeBlock: other blocks are untouched by the checks", () => {
  assert.equal(mergeBlock({ ci: "success", mergeable: "CONFLICTING", mergeState: "DIRTY", checks: [chk("test", "success")] }), "Has conflicts");
});

test("checkNames: only the asked state; a check without a name is skipped", () => {
  assert.equal(checkNames([chk("a", "failure"), { state: "failure" }, chk("b", "pending")], "failure"), "a");
  assert.equal(checkNames(undefined, "failure"), "");
  assert.equal(checkNames([chk("build", "failure"), chk("build", "failure"), chk("lint", "failure")], "failure"), "build, lint", "a repeated name is listed once");
  assert.equal(checkNames([chk("a", "failure"), chk("a", "failure"), chk("b", "failure"), chk("c", "failure"), chk("d", "failure")], "failure"), "a, b, c +1 more", "the count is of names, not of checks");
});

const settings = { settings: { squash: true, merge: true, rebase: true }, hasStaging: false, lastMethod: null, allowedByRules: null };
const detail = (o = {}) => ({ mergeable: "MERGEABLE", mergeState: "CLEAN", ci: "success", isDraft: false, headOid: "aaa", head: "fix/x", base: "main", checks: [], ...o });

test("mergeView: the reason names the failing checks from the loaded detail", () => {
  const v = mergeView({ item: pr(1), detail: detail({ ci: "failure", checks: [chk("test", "failure"), chk("Boot smoke test", "failure")] }), repo: settings });
  assert.equal(v.status, "blocked");
  assert.equal(v.reason, "CI failing: test, Boot smoke test");
  assert.equal(v.enabled, false);
});

test("mergeView: running checks are named, and an issue-like detail without checks falls back", () => {
  assert.equal(mergeView({ item: pr(1), detail: detail({ ci: "pending", checks: [chk("e2e", "pending")] }), repo: settings }).reason, "CI running: e2e");
  assert.equal(mergeView({ item: pr(1), detail: detail({ ci: "failure", checks: null }), repo: settings }).reason, "CI is failing");
});

test("preflight: the abort reason names the checks too", () => {
  const armed = { draft: false, headOid: "aaa", base: "main", head: "fix/x" };
  assert.equal(preflight(armed, detail({ ci: "failure", checks: [chk("test", "failure")] }), pr(1)), "CI failing: test");
});

test("groupOf: a labels.review label keeps a reviewed PR in To review, unless CI fails or changes are requested", () => {
  const config = normalizeConfig({ labels: { review: ["needs-review"] } }).config;
  const base = { ci: "success", reviewDecision: null, labels: ["needs-review"], comments: [{ author: "sam", body: "looks fine", createdAt: "2026-01-01T00:00:00Z" }] };
  assert.equal(group({ ...base, reviewDecision: "REVIEW_REQUIRED" }, config), "review");
  assert.equal(group({ ...base, ci: "failure" }, config), "fixing");
  assert.equal(group({ ...base, reviewDecision: "CHANGES_REQUESTED" }, config), "fixing");
});

test("groupOf: with labels.review, an approved PR whose CI still runs is To review, not Waiting", () => {
  const withLabel = normalizeConfig({ labels: { review: ["needs-review"] } }).config;
  const p = { ci: "pending", reviewDecision: "APPROVED", labels: ["needs-review"] };
  assert.equal(group(p), "waiting");
  assert.equal(group(p, withLabel), "review");
});
