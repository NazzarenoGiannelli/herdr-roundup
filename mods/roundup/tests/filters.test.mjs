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

test("DEFAULT_FILTERS: nothing ticked (All), not merged, every repository", () => {
  assert.deepEqual({ ...DEFAULT_FILTERS, groups: [...DEFAULT_FILTERS.groups], repos: [...DEFAULT_FILTERS.repos] },
    { v: 2, groups: [], deps: false, merged: false, repos: [] });
  assert.deepEqual(normalizeFilters(null), { v: 2, groups: [], deps: false, merged: false, repos: [] });
});

test("normalizeFilters: unknown keys and groups are dropped, missing or wrong fields take the default", () => {
  const f = normalizeFilters({ v: 2, groups: ["drafts", "nope", "ready"], deps: "yes", merged: 1, repos: ["acme/w", "", 3, "acme/a", "acme/w"], extra: true });
  assert.deepEqual(f, { v: 2, groups: ["ready", "drafts"], deps: false, merged: false, repos: ["acme/a", "acme/w"] });
});

test("normalizeFilters: a state from the first version starts the status again from All, keeps repositories and Merged", () => {
  assert.deepEqual(normalizeFilters({ groups: ["ready"], deps: false, merged: false, repos: ["acme/w"] }), { v: 2, groups: [], deps: false, merged: false, repos: ["acme/w"] });
  assert.deepEqual(normalizeFilters({ groups: [...GROUP_IDS], deps: true, merged: true, repos: [] }), { v: 2, groups: [], deps: false, merged: true, repos: [] });
});

test("normalizeFilters: every group ticked is All; Merged clears the rest", () => {
  assert.deepEqual(normalizeFilters({ v: 2, groups: [...GROUP_IDS], deps: true }).groups, []);
  assert.equal(normalizeFilters({ v: 2, groups: [...GROUP_IDS], deps: true }).deps, false);
  assert.deepEqual(normalizeFilters({ v: 2, groups: ["ready"], deps: true, merged: true }), { v: 2, groups: [], deps: false, merged: true, repos: [] });
});

test("normalizeFilters: garbage of any type gives the default", () => {
  for (const g of [undefined, 0, "x", [], [1], true]) assert.deepEqual(normalizeFilters(g), normalizeFilters(null));
});

test("normalizeFilters does not share arrays with its input or with the default", () => {
  const input = { v: 2, groups: ["ready"], repos: ["acme/w"] };
  const f = normalizeFilters(input);
  f.groups.push("drafts"); f.repos.push("acme/x");
  assert.deepEqual(input, { v: 2, groups: ["ready"], repos: ["acme/w"] });
  assert.deepEqual([...DEFAULT_FILTERS.groups], []);
});

test("parseStored: JSON text of a state; broken or empty text gives the default", () => {
  assert.deepEqual(parseStored(JSON.stringify({ v: 2, groups: ["review"], repos: ["acme/w"] })).groups, ["review"]);
  for (const t of [null, "", "{", "null", "[]"]) assert.deepEqual(parseStored(t), normalizeFilters(null));
});

// --- applying --------------------------------------------------------------------------------------

test("applyFilters: nothing ticked shows every open PR", () => {
  assert.deepEqual(numbers(applyFilters(sample(), all(), { tab: "pr" })), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("applyFilters: ticked groups show only those groups", () => {
  assert.deepEqual(numbers(applyFilters(sample(), all({ groups: ["ready"] }), { tab: "pr" })), [1, 7]);
  assert.deepEqual(numbers(applyFilters(sample(), all({ groups: ["fixing", "drafts"] }), { tab: "pr" })), [3, 5, 8]);
});

test("applyFilters: Dependencies alone shows the dependency updates of every group, bots and labels alike", () => {
  const labelled = pr(9, { labels: ["dependencies"] });
  assert.deepEqual(numbers(applyFilters([...sample(), labelled], all({ deps: true }), { tab: "pr" })), [6, 7, 9]);
});

test("applyFilters: groups and Dependencies add up (a PR shows when either matches)", () => {
  assert.deepEqual(numbers(applyFilters(sample(), all({ groups: ["fixing"], deps: true }), { tab: "pr" })), [3, 6, 7, 8]);
});

test("applyFilters: repositories narrow both tabs, several at once, empty means all", () => {
  assert.deepEqual(numbers(applyFilters(sample(), all({ repos: ["acme/gadgets"] }), { tab: "pr" })), [7, 8]);
  assert.deepEqual(numbers(applyFilters(sample(), all({ repos: ["acme/gadgets"], groups: ["fixing"] }), { tab: "pr" })), [8]);
  const issues = [pr(1), pr(2, { repo: "acme/gadgets" })];
  assert.deepEqual(numbers(applyFilters(issues, all({ repos: ["acme/gadgets", "acme/widgets"] }), { tab: "issue" })), [1, 2]);
});

test("applyFilters: the issue tab ignores groups, Dependencies and Merged", () => {
  const issues = [pr(1), pr(2, { repo: "acme/gadgets" })];
  assert.deepEqual(numbers(applyFilters(issues, all({ groups: ["ready"], deps: true }), { tab: "issue" })), [1, 2]);
  assert.deepEqual(numbers(applyFilters(issues, all({ merged: true }), { tab: "issue" })), [1, 2]);
});

test("applyFilters: Merged shows its own list, narrowed by repositories only", () => {
  const merged = [pr(20), pr(21, { repo: "acme/gadgets" })];
  assert.deepEqual(numbers(applyFilters(merged, all({ merged: true }), { tab: "pr" })), [20, 21]);
  assert.deepEqual(numbers(applyFilters(merged, all({ merged: true, repos: ["acme/gadgets"] }), { tab: "pr" })), [21]);
});

test("applyFilters does not change its input", () => {
  const items = sample(), before = JSON.stringify(items);
  applyFilters(items, all({ groups: ["ready"], repos: ["acme/gadgets"] }), { tab: "pr" });
  assert.equal(JSON.stringify(items), before);
});

// --- counts and labels -----------------------------------------------------------------------------

test("statusCounts: PRs per group and dependency PRs, within the selected repositories", () => {
  assert.deepEqual(statusCounts(sample(), null, []), { groups: { ready: 2, review: 2, fixing: 2, waiting: 1, drafts: 1 }, deps: 2, merged: null });
  assert.deepEqual(statusCounts(sample(), null, ["acme/gadgets"]).groups, { ready: 1, review: 0, fixing: 1, waiting: 0, drafts: 0 });
});

test("statusCounts: the Merged count is the merged list's size in the selected repositories, null until loaded", () => {
  assert.equal(statusCounts([], null, []).merged, null);
  assert.equal(statusCounts([], [pr(20), pr(21, { repo: "acme/gadgets" })], ["acme/gadgets"]).merged, 1);
});

test("statusLabel: All, Merged, one box by name, more as a count", () => {
  assert.equal(statusLabel(all()), "Status: All");
  assert.equal(statusLabel(all({ merged: true })), "Status: Merged");
  assert.equal(statusLabel(all({ groups: ["drafts"] })), "Status: Drafts");
  assert.equal(statusLabel(all({ deps: true })), "Status: Dependencies");
  assert.equal(statusLabel(all({ groups: ["ready", "fixing"] })), "Status: 2");
  assert.equal(statusLabel(all({ groups: ["ready"], deps: true })), "Status: 2");
});

test("reposLabel: All, one name, two names, a count", () => {
  assert.equal(reposLabel(all()), "Repos: All");
  assert.equal(reposLabel(all({ repos: ["acme/widgets"] })), "Repos: widgets");
  assert.equal(reposLabel(all({ repos: ["acme/gadgets", "acme/widgets"] })), "Repos: gadgets, widgets");
  assert.equal(reposLabel(all({ repos: ["a/x", "a/y", "a/z"] })), "Repos: 3");
});

test("isAllStatus and isDefault", () => {
  assert.equal(isAllStatus(all()), true);
  assert.equal(isAllStatus(all({ groups: ["ready"] })), false);
  assert.equal(isAllStatus(all({ deps: true })), false);
  assert.equal(isAllStatus(all({ merged: true })), false);
  assert.equal(isDefault(all()), true);
  assert.equal(isDefault(all({ repos: ["acme/w"] })), false);
});

// --- the Status menu -------------------------------------------------------------------------------

const counts = () => statusCounts(sample(), [pr(20), pr(21)], []);

test("statusRows: All ticked by default, the groups unticked in order with counts, a separator, Dependencies, a separator, Merged", () => {
  const rows = statusRows(all(), counts(), 7);
  assert.deepEqual(rows.map((r) => r.id), ["all", ...GROUP_IDS, "deps", "merged"]);
  assert.deepEqual(rows.map((r) => r.checked), [true, false, false, false, false, false, false, false]);
  assert.deepEqual(rows.map((r) => r.sepBefore), [false, false, false, false, false, false, true, true]);
  assert.equal(rows.find((r) => r.id === "ready").count, 2);
  assert.equal(rows.find((r) => r.id === "merged").count, 2);
  assert.ok(rows.every((r) => !r.disabled));
});

test("statusRows: ticked boxes show, All is unticked while anything is ticked", () => {
  const rows = statusRows(all({ groups: ["ready"], deps: true }), counts(), 7);
  assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.id), ["ready", "deps"]);
});

test("statusRows: the Merged count is null (no number) until the list has loaded", () => {
  assert.equal(statusRows(all(), statusCounts(sample(), null, []), 7).at(-1).count, null);
});

test("mergedLabel", () => {
  assert.equal(mergedLabel(7), "Merged (last 7 days)");
  assert.equal(mergedLabel(1), "Merged (last day)");
});

const row = (id) => statusRows(all(), counts(), 7).find((r) => r.id === id);

test("toggleStatus: ticking a group or Dependencies starts filtering; unticking the last one is All again", () => {
  let f = toggleStatus(all(), row("ready"));
  assert.deepEqual(f.groups, ["ready"]);
  f = toggleStatus(f, row("deps"));
  assert.equal(f.deps, true);
  f = toggleStatus(toggleStatus(f, row("ready")), row("deps"));
  assert.equal(isAllStatus(f), true);
});

test("toggleStatus: groups stay in group order", () => {
  const f = toggleStatus(toggleStatus(all(), row("drafts")), row("ready"));
  assert.deepEqual(f.groups, ["ready", "drafts"]);
});

test("toggleStatus: ticking all five groups is All", () => {
  let f = all();
  for (const id of GROUP_IDS) f = toggleStatus(f, row(id));
  assert.equal(isAllStatus(f), true);
});

test("toggleStatus: Merged clears the other boxes; a group or Dependencies leaves Merged; unticking Merged is All", () => {
  const picked = all({ groups: ["ready"], deps: true });
  const m = toggleStatus(picked, row("merged"));
  assert.deepEqual({ groups: m.groups, deps: m.deps, merged: m.merged }, { groups: [], deps: false, merged: true });
  assert.deepEqual(toggleStatus(m, row("drafts")).groups, ["drafts"]);
  assert.equal(toggleStatus(m, row("drafts")).merged, false);
  assert.equal(toggleStatus(m, row("deps")).merged, false);
  assert.equal(isAllStatus(toggleStatus(m, row("merged"))), true);
});

test("toggleStatus: All clears every tick and Merged, repositories stay", () => {
  const f = toggleStatus(all({ groups: ["ready"], deps: true, merged: false, repos: ["acme/w"] }), row("all"));
  assert.deepEqual(f, { ...all(), repos: ["acme/w"] });
});

test("toggleStatus does not change its input", () => {
  const f = all({ groups: ["ready"] }), before = JSON.stringify(f);
  toggleStatus(f, row("drafts"));
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
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i, disabled: i !== 0 && i !== 7 })); // only 0 and 7 enabled
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
