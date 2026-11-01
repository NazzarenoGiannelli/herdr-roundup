// Pure logic for the two filter dropdowns (Status and Repos) of the Roundup panel.
// Imports only ./rules.js, ./browse.js and ./config.js (loaded by Node tests and by the Herdr runtime).
//
// Both menus work the same way: "All" is ticked until you tick something, and what you tick is what
// is shown (several ticks add up). The state is one small object, shared by both tabs:
//   { v: 2, groups: [group ids], deps: boolean, merged: boolean, repos: [owner/repo, ...] }
// groups and deps pick open PRs (a PR shows when its group is ticked, or when deps is ticked and it is
// a dependency update); nothing ticked means every open PR. merged swaps the open PRs for the Merged
// list and is exclusive. These three apply to the PR tab only. repos applies to both tabs; empty is all.

import { groupOf, views, chips, GROUP_IDS } from "./rules.js";
import { GROUPS, shortRepo } from "./browse.js";
import { DEFAULT_CONFIG } from "./config.js";

export const FILTERS_VERSION = 2;
export const DEFAULT_FILTERS = Object.freeze({ v: FILTERS_VERSION, groups: Object.freeze([]), deps: false, merged: false, repos: Object.freeze([]) });

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Every group ticked shows what "All" shows: it becomes All.
const settle = (f) => (f.groups.length === GROUP_IDS.length ? { ...f, groups: [] , deps: false } : f);

// Anything -> a valid state. Unknown keys are dropped, missing or wrongly typed fields take the default,
// unknown group ids are dropped, repositories are kept as they are (one that no longer exists is harmless)
// and sorted by name without duplicates. A state saved by the first version (no `v`: its boxes meant
// "hide what is unticked") keeps its repositories and Merged and starts the status again from All.
export function normalizeFilters(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const current = o.v === FILTERS_VERSION;
  const groups = current && Array.isArray(o.groups) ? GROUP_IDS.filter((id) => o.groups.includes(id)) : [];
  const repos = Array.isArray(o.repos) ? [...new Set(o.repos.filter((r) => typeof r === "string" && r.trim() !== ""))].sort(byName) : [];
  const merged = o.merged === true;
  return settle({ v: FILTERS_VERSION, groups: merged ? [] : groups, deps: !merged && current && o.deps === true, merged, repos });
}

// What localStorage holds: JSON text -> a state (garbage and null give the default).
export function parseStored(text) {
  try { return normalizeFilters(JSON.parse(text)); } catch { return normalizeFilters(null); }
}

export const isDependency = (pr, config = DEFAULT_CONFIG) => views(pr, config).includes("deps");

// Applies the state to a tab's items. Issues and the Merged list: repositories only. Open PRs:
// repositories, then the ticked groups and Dependencies (added together; none ticked is all).
export function applyFilters(items, filters, { tab, config = DEFAULT_CONFIG } = {}) {
  const repos = new Set(filters.repos);
  const inRepos = (it) => repos.size === 0 || repos.has(it.repo);
  if (tab !== "pr" || filters.merged) return items.filter(inRepos);
  if (filters.groups.length === 0 && !filters.deps) return items.filter(inRepos);
  const groups = new Set(filters.groups);
  return items.filter((it) => inRepos(it) && (groups.has(groupOf(it, config)) || (filters.deps && isDependency(it, config))));
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

export const isAllStatus = (f) => f.groups.length === 0 && !f.deps && !f.merged;
// True when the state shows everything: no repository narrowing either.
export const isDefault = (f) => isAllStatus(f) && f.repos.length === 0;

// --- the two buttons --------------------------------------------------------------------------------

// "Status: All", "Status: Merged", one ticked box by name ("Status: Drafts"), more as a count ("Status: 3").
export function statusLabel(f) {
  if (f.merged) return "Status: Merged";
  const names = [...GROUPS.filter(({ id }) => f.groups.includes(id)).map(({ label }) => label), ...(f.deps ? ["Dependencies"] : [])];
  if (names.length === 0) return "Status: All";
  return names.length === 1 ? `Status: ${names[0]}` : `Status: ${names.length}`;
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

// The rows of the Status menu, top to bottom. `sepBefore`: a separator line above the row. `count`:
// null for no number. Every row can be ticked.
export function statusRows(f, counts, mergedDays) {
  return [
    { id: "all", kind: "all", label: "All", count: null, checked: isAllStatus(f), disabled: false, sepBefore: false },
    ...GROUPS.map(({ id, label }) => ({ id, kind: "group", label, count: counts.groups[id] ?? 0, checked: f.groups.includes(id), disabled: false, sepBefore: false })),
    { id: "deps", kind: "deps", label: "Dependencies", count: counts.deps, checked: f.deps, disabled: false, sepBefore: true },
    { id: "merged", kind: "merged", label: mergedLabel(mergedDays), count: counts.merged, checked: f.merged, disabled: false, sepBefore: true },
  ];
}

export const statusMenuHeight = (rows) => rows.length * MENU_ROW_H + rows.filter((r) => r.sepBefore).length * MENU_SEP_H + MENU_PAD;

// Ticks or unticks one row of the Status menu; returns the new state. "All" clears every tick. A group
// or Dependencies leaves Merged. Merged clears the rest. Unticking the last box is All again.
export function toggleStatus(f, row) {
  if (row.disabled) return f;
  if (row.kind === "all") return { ...f, groups: [], deps: false, merged: false };
  if (row.kind === "merged") return f.merged ? { ...f, merged: false } : { ...f, groups: [], deps: false, merged: true };
  if (row.kind === "deps") return settle({ ...f, deps: !f.deps, merged: false });
  const on = f.groups.includes(row.id);
  return settle({ ...f, merged: false, groups: GROUP_IDS.filter((id) => (id === row.id ? !on : f.groups.includes(id))) });
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

// --- opening and closing the menus ---------------------------------------------------------------------

export const MENU_GAP = 4;          // px between a button's bottom edge and its menu
export const RECLOSE_MS = 400;      // a press within this long of the menu closing is the press that closed it

// Where a menu opens: under the pressed button, left edges aligned, whatever spot of the button was
// pressed. From the press event: `bounds` (the button's box), else position minus local position.
// "pointer" when the event says nothing about the button (not painted yet).
export function menuAnchor(e, height = 24, gap = MENU_GAP) {
  if (e?.bounds && Number.isFinite(e.bounds.x) && Number.isFinite(e.bounds.y)) {
    return { x: Math.round(e.bounds.x), y: Math.round(e.bounds.y + (e.bounds.height ?? height) + gap) };
  }
  if (e?.position && e?.local_position) {
    return { x: Math.round(e.position.x - e.local_position.x), y: Math.round(e.position.y - e.local_position.y + height + gap) };
  }
  return "pointer";
}

// Pressing a menu's button again closes it instead of opening a second one. `menu` is the shared record
// the popup keeps ({ kind, id, open, at }): open, or closed a moment ago by this very press (Herdr closes
// a popup on a press outside it, which can come before the button's click).
export function pressCloses(menu, kind, now, window = RECLOSE_MS) {
  if (!menu || menu.kind !== kind) return false;
  return menu.open === true || (Number.isFinite(menu.at) && now - menu.at < window);
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
