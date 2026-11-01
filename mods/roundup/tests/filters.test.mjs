import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../config.js";
import { GROUP_IDS } from "../rules.js";
import {
  DEFAULT_FILTERS, normalizeFilters, parseStored, applyFilters, statusCounts, isAllStatus, isDefault,
  statusLabel, reposLabel, mergedLabel, statusRows, statusMenuHeight, toggleStatus, repoCounts, repoRows, reposMenuHeight, toggleRepo, nextRow,
  MENU_ROW_H, MENU_SEP_H, MENU_PAD, MENU_MAX_ROWS,
} from "../filters.js";

const pr = (n, o = {}) => ({ repo: "acme/widgets", number: n, isDraft: false, head: "fix/x", base: "staging",
  author: "sam", labels: [], ci: "success", reviewDecision: null, comments: [], ...o });
const READY = { reviewDecision: "APPROVED" };                  // CI passing and approved
const REVIEW = {};                                             // nobody has looked, CI passing
const FIXING = { ci: "failure" };
const WAITING = { reviewDecision: "APPROVED", ci: "pending" };
const DRAFT = { isDraft: true };
const DEP = { author: "dependabot" };                          // a dependency PR
const all = (extra = {}) => ({ ...normalizeFilters(null), ...extra });
const numbers = (items) => items.map((i) => i.number);

// Groups: 1 ready, 2 review, 3 fixing, 4 waiting, 5 drafts, 6 review (dependency), 7 ready (dependency, gadgets), 8 fixing (gadgets).
const sample = () => [
  pr(1, READY), pr(2, REVIEW), pr(3, FIXING), pr(4, WAITING), pr(5, DRAFT),
  pr(6, { ...DEP }), pr(7, { ...DEP, ...READY, repo: "acme/gadgets" }), pr(8, { repo: "acme/gadgets", ...FIXING }),
];

// --- state -------------------------------------------------------------------------------------------

test("DEFAULT_FILTERS: every group, dependencies on, not merged, every repository", () => {
  assert.deepEqual(normalizeFilters(null), { groups: GROUP_IDS, deps: true, merged: false, repos: [] });
  assert.deepEqual(normalizeFilters(DEFAULT_FILTERS), normalizeFilters(null));
  assert.equal(isAllStatus(DEFAULT_FILTERS), true);
  assert.equal(isDefault(DEFAULT_FILTERS), true);
});

test("normalizeFilters: unknown keys and groups are dropped, missing or wrong fields take the default", () => {
  const f = normalizeFilters({ groups: ["waiting", "nonsense", "ready", 7], deps: "no", merged: "yes", repos: ["b/y", "a/x", "b/y", "", 5, null], extra: 1, at: 123 });
  assert.deepEqual(f, { groups: ["ready", "waiting"], deps: true, merged: false, repos: ["a/x", "b/y"] }, "groups in group order, repos sorted and unique");
  assert.deepEqual(normalizeFilters({ groups: [], deps: false, merged: true }), { groups: [], deps: false, merged: true, repos: [] }, "an empty list of groups is a real choice");
  assert.deepEqual(normalizeFilters({ repos: "a/x" }).repos, []);
});

test("normalizeFilters: garbage of any type gives the default", () => {
  for (const raw of [undefined, null, 0, 5, "text", true, [], [1, 2], () => 1]) assert.deepEqual(normalizeFilters(raw), normalizeFilters(null), String(raw));
});

test("normalizeFilters does not share arrays with its input or with the default", () => {
  const a = normalizeFilters(null), b = normalizeFilters(null);
  a.groups.pop(); a.repos.push("x/y");
  assert.deepEqual(b, normalizeFilters(null));
  assert.equal(DEFAULT_FILTERS.groups.length, GROUP_IDS.length);
});

test("parseStored: JSON text of a state; broken or empty text gives the default", () => {
  assert.deepEqual(parseStored(JSON.stringify({ groups: ["ready"], deps: false, merged: false, repos: ["a/x"] })), { groups: ["ready"], deps: false, merged: false, repos: ["a/x"] });
  for (const text of ["", "{not json", "null", "[1]", "\"str\"", undefined]) assert.deepEqual(parseStored(text), normalizeFilters(null), String(text));
});

// --- applying ----------------------------------------------------------------------------------------

test("applyFilters: the default shows every open PR", () => {
  assert.deepEqual(numbers(applyFilters(sample(), all(), { tab: "pr" })), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("applyFilters: an unchecked group is not shown", () => {
  const f = all({ groups: ["ready", "fixing"] });
  assert.deepEqual(numbers(applyFilters(sample(), f, { tab: "pr" })), [1, 3, 7, 8]);
  assert.deepEqual(applyFilters(sample(), all({ groups: [] }), { tab: "pr" }), []);
});

test("applyFilters: Dependencies off hides dependency PRs from every group, bots and labels alike", () => {
  const config = normalizeConfig({ labels: { deps: ["deps-update"] } }).config;
  const items = [...sample(), pr(9, { labels: ["deps-update"], ...FIXING }), pr(10, { author: "renovate[bot]", ...DRAFT })];
  assert.deepEqual(numbers(applyFilters(items, all({ deps: false }), { tab: "pr", config })), [1, 2, 3, 4, 5, 8]);
  assert.deepEqual(numbers(applyFilters(items, all({ deps: true }), { tab: "pr", config })), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("applyFilters: groups and Dependencies combine (AND)", () => {
  assert.deepEqual(numbers(applyFilters(sample(), all({ groups: ["ready", "review"], deps: false }), { tab: "pr" })), [1, 2]);
});

test("applyFilters: repositories narrow both tabs, several at once, empty means all", () => {
  const f = all({ repos: ["acme/gadgets"] });
  assert.deepEqual(numbers(applyFilters(sample(), f, { tab: "pr" })), [7, 8]);
  assert.deepEqual(numbers(applyFilters(sample(), all({ repos: ["acme/gadgets", "acme/widgets"] }), { tab: "pr" })), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(numbers(applyFilters(sample(), all({ repos: ["acme/nothing"] }), { tab: "pr" })), []);
  assert.deepEqual(numbers(applyFilters(sample(), f, { tab: "issue" })), [7, 8]);
});

test("applyFilters: the issue tab ignores groups, Dependencies and Merged", () => {
  const issues = [{ repo: "acme/widgets", number: 1, labels: [], author: "dependabot", ci: "failure" }, { repo: "acme/gadgets", number: 2, labels: [] }];
  const f = all({ groups: [], deps: false, merged: true });
  assert.deepEqual(numbers(applyFilters(issues, f, { tab: "issue" })), [1, 2]);
  assert.deepEqual(numbers(applyFilters(issues, { ...f, repos: ["acme/gadgets"] }, { tab: "issue" })), [2]);
});

test("applyFilters: Merged is exclusive, so the groups and Dependencies are ignored there; repositories still apply", () => {
  const merged = [pr(1, { merged: true, author: "dependabot", ...FIXING }), pr(2, { merged: true, repo: "acme/gadgets" })];
  const f = all({ merged: true, groups: [], deps: false });
  assert.deepEqual(numbers(applyFilters(merged, f, { tab: "pr" })), [1, 2]);
  assert.deepEqual(numbers(applyFilters(merged, { ...f, repos: ["acme/gadgets"] }, { tab: "pr" })), [2]);
});

test("applyFilters does not change its input", () => {
  const items = sample(), before = JSON.stringify(items);
  applyFilters(items, all({ groups: ["ready"], deps: false }), { tab: "pr" });
  assert.equal(JSON.stringify(items), before);
});

// --- counts ------------------------------------------------------------------------------------------

test("statusCounts: PRs per group and dependency PRs, within the selected repositories", () => {
  const c = statusCounts(sample(), null, []);
  assert.deepEqual(c, { groups: { ready: 2, review: 2, fixing: 2, waiting: 1, drafts: 1 }, deps: 2, merged: null });
  assert.deepEqual(statusCounts(sample(), null, ["acme/gadgets"]), { groups: { ready: 1, review: 0, fixing: 1, waiting: 0, drafts: 0 }, deps: 1, merged: null });
});

test("statusCounts: the Merged count is the merged list's size in the selected repositories, null until loaded", () => {
  const merged = [pr(1), pr(2, { repo: "acme/gadgets" }), pr(3)];
  assert.equal(statusCounts([], merged, []).merged, 3);
  assert.equal(statusCounts([], merged, ["acme/gadgets"]).merged, 1);
  assert.equal(statusCounts([], [], []).merged, 0);
  assert.equal(statusCounts([], null, []).merged, null);
});

test("statusCounts: an empty list counts zeros for every group", () => {
  assert.deepEqual(statusCounts([], null, []).groups, { ready: 0, review: 0, fixing: 0, waiting: 0, drafts: 0 });
});

// --- the buttons -------------------------------------------------------------------------------------

test("statusLabel: All, Merged, n of 5, and no deps", () => {
  assert.equal(statusLabel(all()), "Status: All");
  assert.equal(statusLabel(all({ merged: true })), "Status: Merged");
  assert.equal(statusLabel(all({ merged: true, deps: false, groups: [] })), "Status: Merged", "Merged says nothing else");
  assert.equal(statusLabel(all({ groups: ["ready", "review", "fixing"] })), "Status: 3 of 5");
  assert.equal(statusLabel(all({ groups: ["drafts"] })), "Status: 1 of 5");
  assert.equal(statusLabel(all({ groups: [] })), "Status: 0 of 5");
  assert.equal(statusLabel(all({ deps: false })), "Status: All · no deps");
  assert.equal(statusLabel(all({ deps: false, groups: ["ready", "review", "fixing", "waiting"] })), "Status: 4 of 5 · no deps");
});

test("reposLabel: All, one name, two names, a count", () => {
  assert.equal(reposLabel(all()), "Repos: All");
  assert.equal(reposLabel(all({ repos: ["acme/widgets"] })), "Repos: widgets");
  assert.equal(reposLabel(all({ repos: ["acme/gadgets", "acme/widgets"] })), "Repos: gadgets, widgets");
  assert.equal(reposLabel(all({ repos: ["acme/a", "acme/b", "acme/c"] })), "Repos: 3");
  assert.equal(reposLabel(all({ repos: ["a/1", "a/2", "a/3", "a/4", "a/5"] })), "Repos: 5");
});

test("isAllStatus and isDefault", () => {
  assert.equal(isAllStatus(all({ deps: false })), false);
  assert.equal(isAllStatus(all({ merged: true })), false);
  assert.equal(isAllStatus(all({ repos: ["a/x"] })), true, "repositories are not part of the status");
  assert.equal(isDefault(all({ repos: ["a/x"] })), false);
});

// --- the Status menu ---------------------------------------------------------------------------------

const counts = () => statusCounts(sample(), [pr(20), pr(21)], []);

test("statusRows: All, the groups in order with counts, a separator, Dependencies, a separator, Merged", () => {
  const rows = statusRows(all(), counts(), 7);
  assert.deepEqual(rows.map((r) => r.label), ["All", "Ready to merge", "To review", "Needs fixing", "Waiting", "Drafts", "Dependencies", "Merged (last 7 days)"]);
  assert.deepEqual(rows.map((r) => r.count), [null, 2, 2, 2, 1, 1, 2, 2]);
  assert.deepEqual(rows.map((r) => r.sepBefore), [false, false, false, false, false, false, true, true]);
  assert.deepEqual(rows.map((r) => r.checked), [true, true, true, true, true, true, true, false]);
  assert.equal(rows.some((r) => r.disabled), false);
});

test("statusRows: Merged on greys out the groups and Dependencies, All stays unchecked and enabled", () => {
  const rows = statusRows(all({ merged: true }), counts(), 1);
  assert.deepEqual(rows.map((r) => r.disabled), [false, true, true, true, true, true, true, false]);
  assert.equal(rows[0].checked, false);
  assert.equal(rows.at(-1).checked, true);
  assert.equal(rows.at(-1).label, "Merged (last day)");
});

test("statusRows: the Merged count is null (no number) until the list has loaded", () => {
  assert.equal(statusRows(all(), statusCounts(sample(), null, []), 7).at(-1).count, null);
});

test("mergedLabel", () => {
  assert.equal(mergedLabel(7), "Merged (last 7 days)");
  assert.equal(mergedLabel(1), "Merged (last day)");
  assert.equal(mergedLabel(30), "Merged (last 30 days)");
});

test("toggleStatus: a group, Dependencies and Merged each flip on their own", () => {
  const rows = statusRows(all(), counts(), 7), row = (id) => rows.find((r) => r.id === id);
  let f = toggleStatus(all(), row("waiting"));
  assert.deepEqual(f.groups, ["ready", "review", "fixing", "drafts"], "group order is kept");
  f = toggleStatus(f, row("waiting"));
  assert.deepEqual(f.groups, GROUP_IDS);
  assert.equal(toggleStatus(all(), row("deps")).deps, false);
  assert.equal(toggleStatus(all(), row("merged")).merged, true);
  assert.equal(toggleStatus(all({ merged: true }), row("merged")).merged, false);
});

test("toggleStatus: unchecking Merged returns to the open PRs with the previous checkboxes", () => {
  const before = all({ groups: ["ready", "fixing"], deps: false });
  const on = toggleStatus(before, statusRows(before, counts(), 7).at(-1));
  assert.equal(on.merged, true);
  assert.deepEqual([on.groups, on.deps], [before.groups, before.deps], "the checkboxes are untouched while Merged is on");
  const off = toggleStatus(on, statusRows(on, counts(), 7).at(-1));
  assert.deepEqual(off, before);
});

test("toggleStatus: a disabled row changes nothing", () => {
  const f = all({ merged: true }), rows = statusRows(f, counts(), 7);
  for (const id of ["ready", "review", "fixing", "waiting", "drafts", "deps"]) assert.deepEqual(toggleStatus(f, rows.find((r) => r.id === id)), f, id);
});

test("toggleStatus: All checks every group and Dependencies and switches Merged off, repositories stay", () => {
  const f = all({ groups: ["ready"], deps: false, merged: true, repos: ["acme/gadgets"] });
  const next = toggleStatus(f, statusRows(f, counts(), 7)[0]);
  assert.deepEqual(next, { groups: GROUP_IDS, deps: true, merged: false, repos: ["acme/gadgets"] });
});

test("toggleStatus does not change its input", () => {
  const f = all({ groups: ["ready"] }), before = JSON.stringify(f);
  toggleStatus(f, statusRows(f, counts(), 7)[2]);
  assert.equal(JSON.stringify(f), before);
});

test("statusMenuHeight: rows, separators and padding", () => {
  const rows = statusRows(all(), counts(), 7);
  assert.equal(statusMenuHeight(rows), 8 * MENU_ROW_H + 2 * MENU_SEP_H + MENU_PAD);
});

// --- the Repos menu ----------------------------------------------------------------------------------

const many = () => [pr(1), pr(2), pr(3, { repo: "acme/gadgets" }), pr(4, { repo: "acme/anvils" }), pr(5, { repo: "acme/gadgets" }), pr(6, { repo: "acme/zeta" })];

test("repoCounts: every repository with its count, most items first, ties by name", () => {
  assert.deepEqual(repoCounts(many(), []), [
    { repo: "acme/gadgets", count: 2 }, { repo: "acme/widgets", count: 2 },
    { repo: "acme/anvils", count: 1 }, { repo: "acme/zeta", count: 1 },
  ]);
  assert.deepEqual(repoCounts([], []), []);
});

test("repoCounts: a selected repository without items stays, with 0, after the ones that have items", () => {
  const c = repoCounts(many(), ["acme/gone", "acme/zeta"]);
  assert.deepEqual(c.at(-1), { repo: "acme/gone", count: 0 });
  assert.equal(c.find((x) => x.repo === "acme/zeta").count, 1);
  assert.equal(c.length, 5);
  assert.deepEqual(repoCounts([], ["b/y", "a/x"]), [{ repo: "a/x", count: 0 }, { repo: "b/y", count: 0 }], "zeros tie by name");
});

test("repoRows: All first (checked when nothing is selected), then a row per repository", () => {
  const c = repoCounts(many(), []);
  let rows = repoRows(c, []);
  assert.deepEqual(rows.map((r) => r.label), ["All", "gadgets", "widgets", "anvils", "zeta"]);
  assert.deepEqual(rows.map((r) => r.checked), [true, false, false, false, false]);
  rows = repoRows(c, ["acme/zeta", "acme/gadgets"]);
  assert.deepEqual(rows.map((r) => r.checked), [false, true, false, false, true]);
  assert.deepEqual(rows.map((r) => r.count), [null, 2, 2, 1, 1]);
});

test("repoRows: a selected repository with no items is marked empty (greyed) and stays checkable", () => {
  const rows = repoRows(repoCounts(many(), ["acme/gone"]), ["acme/gone"]);
  const gone = rows.find((r) => r.repo === "acme/gone");
  assert.deepEqual([gone.count, gone.empty, gone.checked, gone.disabled], [0, true, true, false]);
  assert.equal(rows.filter((r) => r.empty).length, 1);
});

test("toggleRepo: a repository joins and leaves the selection, kept sorted", () => {
  const rows = repoRows(repoCounts(many(), []), []), row = (r) => rows.find((x) => x.repo === r);
  let f = toggleRepo(all(), row("acme/widgets"));
  f = toggleRepo(f, row("acme/gadgets"));
  assert.deepEqual(f.repos, ["acme/gadgets", "acme/widgets"]);
  f = toggleRepo(f, row("acme/widgets"));
  assert.deepEqual(f.repos, ["acme/gadgets"]);
  f = toggleRepo(f, row("acme/gadgets"));
  assert.deepEqual(f.repos, [], "nothing selected means All");
});

test("toggleRepo: All clears the selection and leaves the status alone", () => {
  const f = all({ repos: ["a/x", "b/y"], groups: ["ready"] });
  assert.deepEqual(toggleRepo(f, repoRows([], [])[0]), { ...f, repos: [] });
});

test("toggleRepo: unchecking a selected repository that has no items removes it", () => {
  const f = all({ repos: ["acme/gone"] });
  const rows = repoRows(repoCounts(many(), f.repos), f.repos);
  assert.deepEqual(toggleRepo(f, rows.find((r) => r.repo === "acme/gone")).repos, []);
});

test("reposMenuHeight: capped at twelve rows", () => {
  assert.equal(reposMenuHeight(Array(3).fill({})), 3 * MENU_ROW_H + MENU_PAD);
  assert.equal(reposMenuHeight(Array(40).fill({})), MENU_MAX_ROWS * MENU_ROW_H + MENU_PAD);
});

// --- keyboard ----------------------------------------------------------------------------------------

test("nextRow: wraps around and skips disabled rows", () => {
  const rows = statusRows(all({ merged: true }), counts(), 7);      // only All (0) and Merged (7) are enabled
  assert.equal(nextRow(rows, 0, 1), 7);
  assert.equal(nextRow(rows, 7, 1), 0);
  assert.equal(nextRow(rows, 0, -1), 7);
  const free = statusRows(all(), counts(), 7);
  assert.equal(nextRow(free, 7, 1), 0);
  assert.equal(nextRow(free, 0, -1), 7);
  assert.equal(nextRow(free, 2, 1), 3);
});

test("nextRow: a menu with one enabled row stays on it", () => {
  assert.equal(nextRow([{ disabled: false }], 0, 1), 0);
  assert.equal(nextRow([{ disabled: true }, { disabled: true }], 1, 1), 1);
});
