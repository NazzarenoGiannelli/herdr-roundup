// Pure logic for the two filter dropdowns (Status and Repos) of the Roundup panel.
// Imports only ./rules.js, ./browse.js and ./config.js (loaded by Node tests and by the Herdr runtime).
//
// The filter state is one small object, shared by both tabs:
//   { groups: [group ids shown], deps: boolean, merged: boolean, repos: [owner/repo, ...] }
// groups, deps and merged apply to the PR tab only; merged is exclusive (it swaps the open PRs for the
// Merged list). repos applies to both tabs; an empty list means every repository.

import { groupOf, views, chips, GROUP_IDS } from "./rules.js";
import { GROUPS, shortRepo } from "./browse.js";
import { DEFAULT_CONFIG } from "./config.js";

export const DEFAULT_FILTERS = Object.freeze({ groups: Object.freeze([...GROUP_IDS]), deps: true, merged: false, repos: Object.freeze([]) });

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Anything -> a valid state. Unknown keys are dropped, missing or wrongly typed fields take the default,
// unknown group ids are dropped, repositories are kept as they are (one that no longer exists is harmless)
// and sorted by name without duplicates.
export function normalizeFilters(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const groups = Array.isArray(o.groups) ? GROUP_IDS.filter((id) => o.groups.includes(id)) : [...GROUP_IDS];
  const repos = Array.isArray(o.repos) ? [...new Set(o.repos.filter((r) => typeof r === "string" && r.trim() !== ""))].sort(byName) : [];
  return { groups, deps: typeof o.deps === "boolean" ? o.deps : true, merged: o.merged === true, repos };
}

// What localStorage holds: JSON text -> a state (garbage and null give the default).
export function parseStored(text) {
  try { return normalizeFilters(JSON.parse(text)); } catch { return normalizeFilters(null); }
}

export const isDependency = (pr, config = DEFAULT_CONFIG) => views(pr, config).includes("deps");

// Applies the state to a tab's items. Issues: repositories only. Open PRs: repositories, groups and
// dependencies. The Merged list: repositories only (its rows have no group; the checkboxes are greyed).
export function applyFilters(items, filters, { tab, config = DEFAULT_CONFIG } = {}) {
  const repos = new Set(filters.repos);
  const inRepos = (it) => repos.size === 0 || repos.has(it.repo);
  if (tab !== "pr" || filters.merged) return items.filter(inRepos);
  const groups = new Set(filters.groups);
  return items.filter((it) => inRepos(it) && groups.has(groupOf(it, config)) && (filters.deps || !isDependency(it, config)));
}

// The numbers in the Status menu: PRs per group and dependency PRs among the open PRs of the selected
// repositories, and the Merged list's size (null until that list has loaded).
export function statusCounts(prs, mergedItems, repos, config = DEFAULT_CONFIG) {
  const inRepos = (it) => repos.length === 0 || repos.includes(it.repo);
  const counts = { groups: Object.fromEntries(GROUP_IDS.map((id) => [id, 0])), deps: 0, merged: mergedItems ? mergedItems.filter(inRepos).length : null };
  for (const pr of prs.filter(inRepos)) {
    counts.groups[groupOf(pr, config)]++;
    if (isDependency(pr, config)) counts.deps++;
  }
  return counts;
}

export const isAllStatus = (f) => f.groups.length === GROUP_IDS.length && f.deps && !f.merged;
// True when the state shows everything: no repository narrowing either.
export const isDefault = (f) => isAllStatus(f) && f.repos.length === 0;

// --- the two buttons --------------------------------------------------------------------------------

// "Status: All", "Status: Merged", "Status: 3 of 5", with " · no deps" when Dependencies is off
// ("Status: All · no deps" when every group is still on).
export function statusLabel(f) {
  if (f.merged) return "Status: Merged";
  const some = f.groups.length === GROUP_IDS.length ? "All" : `${f.groups.length} of ${GROUP_IDS.length}`;
  return `Status: ${some}${f.deps ? "" : " · no deps"}`;
}

// "Repos: All", "Repos: widgets", "Repos: gadgets, widgets", "Repos: 3".
export function reposLabel(f) {
  const n = f.repos.length;
  if (n === 0) return "Repos: All";
  if (n <= 2) return `Repos: ${f.repos.map(shortRepo).join(", ")}`;
  return `Repos: ${n}`;
}

// --- the menus --------------------------------------------------------------------------------------

export const MENU_ROW_H = 31, MENU_SEP_H = 9, MENU_PAD = 12, MENU_MAX_ROWS = 12;

export const mergedLabel = (days) => `Merged (last ${days === 1 ? "day" : `${days} days`})`;

// The rows of the Status menu, top to bottom. `sepBefore`: a separator line above the row. `disabled`:
// greyed out (the groups and Dependencies while Merged is on). `count`: null for no number.
export function statusRows(f, counts, mergedDays) {
  const off = f.merged;
  return [
    { id: "all", kind: "all", label: "All", count: null, checked: isAllStatus(f), disabled: false, sepBefore: false },
    ...GROUPS.map(({ id, label }) => ({ id, kind: "group", label, count: counts.groups[id] ?? 0, checked: f.groups.includes(id), disabled: off, sepBefore: false })),
    { id: "deps", kind: "deps", label: "Dependencies", count: counts.deps, checked: f.deps, disabled: off, sepBefore: true },
    { id: "merged", kind: "merged", label: mergedLabel(mergedDays), count: counts.merged, checked: f.merged, disabled: false, sepBefore: true },
  ];
}

export const statusMenuHeight = (rows) => rows.length * MENU_ROW_H + rows.filter((r) => r.sepBefore).length * MENU_SEP_H + MENU_PAD;

// Toggles one row of the Status menu; returns the new state. Disabled rows change nothing.
export function toggleStatus(f, row) {
  if (row.disabled) return f;
  if (row.kind === "all") return { ...f, groups: [...GROUP_IDS], deps: true, merged: false };
  if (row.kind === "deps") return { ...f, deps: !f.deps };
  if (row.kind === "merged") return { ...f, merged: !f.merged };
  const on = f.groups.includes(row.id);
  return { ...f, groups: GROUP_IDS.filter((id) => (id === row.id ? !on : f.groups.includes(id))) };
}

// The repository list of the Repos menu: every repository of the list with its count, most items first
// (ties by name), and a selected repository the list no longer has, with 0.
export function repoCounts(items, selected) {
  const have = new Map(chips(items).map((c) => [c.repo, c.count]));
  for (const repo of selected) if (!have.has(repo)) have.set(repo, 0);
  return [...have].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count || byName(a.repo, b.repo));
}

// The Repos menu's rows: "All" first, then one row per repository.
export function repoRows(counts, selected) {
  return [
    { id: "all", kind: "all", repo: null, label: "All", count: null, checked: selected.length === 0, disabled: false },
    ...counts.map((c) => ({ id: c.repo, kind: "repo", repo: c.repo, label: shortRepo(c.repo), count: c.count, checked: selected.includes(c.repo), disabled: false, empty: c.count === 0 })),
  ];
}

export const reposMenuHeight = (rows) => Math.min(rows.length, MENU_MAX_ROWS) * MENU_ROW_H + MENU_PAD;

// Toggles one row of the Repos menu: "All" clears the selection, a repository joins or leaves it.
export function toggleRepo(f, row) {
  if (row.kind === "all") return { ...f, repos: [] };
  const on = f.repos.includes(row.repo);
  return { ...f, repos: (on ? f.repos.filter((r) => r !== row.repo) : [...f.repos, row.repo]).sort(byName) };
}

// The arrow keys of a menu: the next enabled row from `at` in `delta` direction, wrapping around.
export function nextRow(rows, at, delta) {
  const n = rows.length;
  for (let step = 1; step <= n; step++) {
    const i = (((at + delta * step) % n) + n) % n;
    if (!rows[i].disabled) return i;
  }
  return at;
}
