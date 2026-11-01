// Pure list logic for the Roundup panel: filtering, view counts, stable order.
// Imports only ./rules.js and ./config.js (loaded by Node tests and by the Herdr runtime).

import { views, chips, groupOf, GROUP_IDS } from "./rules.js";
import { DEFAULT_CONFIG } from "./config.js";

export const VIEWS = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready to merge" },
  { id: "review", label: "In review" },
  { id: "deps", label: "Dependencies" },
  { id: "drafts", label: "Drafts" },
  { id: "merged", label: "Merged" }, // its own list (main.js), not a filter of the open PRs
];

// A heading row has the key `group:<id>`, which no `owner/repo#n` can equal.
export const keyOf = (item) => item.heading ? `group:${item.group}` : `${item.repo}#${item.number}`;
export const shortRepo = (repo) => String(repo).split("/").pop();

// Views apply to PRs only; the repo chip applies to both tabs. The two combine (AND).
export function select(items, { tab, view, repo }, config = DEFAULT_CONFIG) {
  return items.filter((it) => (!repo || it.repo === repo) && (tab !== "pr" || view === "all" || view === "merged" || views(it, config).includes(view)));
}

export function viewCounts(prs, repo, config = DEFAULT_CONFIG) {
  const inRepo = repo ? prs.filter((p) => p.repo === repo) : prs;
  const counts = { all: inRepo.length, ready: 0, review: 0, deps: 0, drafts: 0 };
  for (const p of inRepo) for (const v of views(p, config)) counts[v]++;
  return counts;
}

// Newest first by updatedAt; rows without a date (or equal dates) keep their order.
const recent = (items) => items.map((it, i) => [it, i]).sort(([a, i], [b, j]) => {
  const x = typeof a.updatedAt === "string" ? a.updatedAt : "", y = typeof b.updatedAt === "string" ? b.updatedAt : "";
  return x && y && x !== y ? (x < y ? 1 : -1) : i - j;
}).map(([it]) => it);

// The Merged view: the most recently merged first.
export const byMerged = (items) => [...items].sort((a, b) => String(b.mergedAt ?? "").localeCompare(String(a.mergedAt ?? "")));

// Rows already shown keep their order across a background refresh: previous order first (rows
// that are gone dropped), then rows that are new, in fetch order. `previous` null re-sorts by
// updatedAt, newest first (a tab, view or chip change, an explicit refresh, the panel shown again).
export function stableOrder(items, previous) {
  if (!previous) return recent(items);
  const rank = new Map(previous.map((k, i) => [k, i]));
  const known = items.filter((it) => rank.has(keyOf(it))).sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));
  return [...known, ...items.filter((it) => !rank.has(keyOf(it)))];
}

// --- groups: whose move it is ---------------------------------------------------------------------

export const GROUPS = [
  { id: "ready", label: "Ready to merge" },
  { id: "review", label: "To review" },
  { id: "fixing", label: "Needs fixing" },
  { id: "waiting", label: "Waiting" },
  { id: "drafts", label: "Drafts" },
];
// The heading rows are shorter than a PR row.
export const HEADING_H = 28;
export const isHeading = (row) => Boolean(row && row.heading);

// Ordered PRs -> rows: a heading `{ heading, group, count }` before the PRs of each group (rules.groupOf),
// groups in GROUPS order, empty groups left out, each group keeping the order it had in `items`.
export function groupRows(items, config = DEFAULT_CONFIG) {
  const by = new Map(GROUP_IDS.map((id) => [id, []]));
  for (const it of items) by.get(groupOf(it, config)).push(it);
  const rows = [];
  for (const { id, label } of GROUPS) {
    const list = by.get(id);
    if (list.length) rows.push({ heading: label, group: id, count: list.length }, ...list);
  }
  return rows;
}

// The rows that can be selected, in order (no headings).
export const selectable = (rows) => rows.filter((r) => !isHeading(r));
// Where `key` sits in `rows`, headings counted (what the list scrolls by); -1 when it is not there.
export const rowIndex = (rows, key) => rows.findIndex((r) => keyOf(r) === key);

// The first `limit` repos by count as chips; the rest go to the "+ more" menu.
// A chosen repo from the menu is promoted to a chip so the selection stays visible.
export function chipsFor(items, selected, limit) {
  const all = chips(items);
  const shown = all.slice(0, limit), more = all.slice(limit);
  const at = more.findIndex((c) => c.repo === selected);
  if (at >= 0) shown.push(...more.splice(at, 1));
  return { shown, more };
}

export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

export function priority(labels) {
  const hit = (labels || []).find((l) => /^priority-(high|medium|low)$/.test(l));
  return hit ? hit.slice("priority-".length) : null;
}

// The line above a list that failed to load; "showing the last list" only when that list is stale.
export function errorLine(kind, error, stale) {
  if (!error) return null;
  return `Couldn't load ${kind === "merged" ? "merged pull requests" : kind === "pr" ? "pull requests" : "issues"}: ${error}${stale ? " · showing the last list" : ""}`;
}

// Issue rows show every label, wrapping onto more rows. The width of a label chip is estimated
// (10px text, padding and border), on the generous side: extra space is better than clipped chips.
const CHIP_CHAR = 6, CHIP_PAD = 12, CHIP_GAP = 4;
export function labelLines(labels, width) {
  if (!labels.length) return 0;
  let lines = 1, used = 0;
  for (const l of labels) {
    const w = String(l).length * CHIP_CHAR + CHIP_PAD;
    if (used > 0 && used + CHIP_GAP + w > width) { lines++; used = w; }
    else used += (used > 0 ? CHIP_GAP : 0) + w;
  }
  return lines;
}

export const ROW_H = 46, LABEL_ROW_H = 20;
// `width` is the room for the label chips: the panel minus list padding, row padding, dot and scrollbar.
export function issueRowHeight(labels, width) {
  const n = labelLines(labels, width);
  return n === 0 ? ROW_H : ROW_H + 2 + n * LABEL_ROW_H - 4;
}

// --- search -------------------------------------------------------------------------------------

// The text typed in the search field, read as: a number (`130`, `#130`), a repository and number
// (`widgets#130`, `owner/repo#130`; `widgets#` alone narrows to the repository), or words (`-` splits them).
// A number among words stays a word.
export function parseQuery(text) {
  const q = String(text ?? "").trim();
  if (q === "" || q === "#") return { number: null, repo: null, words: [] };
  let m = q.match(/^#?(\d+)$/);
  if (m) return { number: Number(m[1]), repo: null, words: [] };
  m = q.match(/^([\w.-]+(?:\/[\w.-]+)?)#(\d*)$/);
  if (m) return { number: m[2] ? Number(m[2]) : null, repo: m[1], words: [] };
  return { number: null, repo: null, words: q.toLowerCase().split(/[\s-]+/).filter(Boolean) };
}

// `widgets` matches the short name, `owner/repo` the full one; case-insensitive, by prefix so that
// "wid#1" already narrows while it is typed.
const inRepo = (item, repo) => {
  const want = repo.toLowerCase(), have = String(item.repo).toLowerCase();
  return (want.includes("/") ? have : shortRepo(have)).startsWith(want);
};
const titleOf = (it) => String(it.title ?? "").toLowerCase();
const textOf = (it) => `${titleOf(it)} ${String(it.repo).toLowerCase()} ${(it.labels || []).join(" ").toLowerCase()}`;

// The whole tab's items that match `text`, best first. Empty query: `items` itself, untouched.
// Number: the exact number (newest first), then numbers starting with the digits (smallest first),
// then titles that mention them. Words: every word in the title, repository or a label, newest first.
export function search(items, text) {
  const q = parseQuery(text);
  if (q.number == null && !q.repo && q.words.length === 0) return items;
  const pool = q.repo ? items.filter((it) => inRepo(it, q.repo)) : items;
  if (q.number != null) {
    const digits = String(q.number);
    const exact = pool.filter((it) => it.number === q.number);
    const starts = pool.filter((it) => it.number !== q.number && String(it.number).startsWith(digits));
    const rank = new Map(recent(starts).map((it, i) => [it, i]));
    starts.sort((a, b) => a.number - b.number || rank.get(a) - rank.get(b));
    // Digits could match part of a repository name: only titles count here.
    const seen = new Set([...exact, ...starts]);
    const titled = pool.filter((it) => !seen.has(it) && titleOf(it).includes(digits));
    return [...recent(exact), ...starts, ...recent(titled)];
  }
  return recent(pool.filter((it) => q.words.every((w) => textOf(it).includes(w))));
}

// A bare number with no open match: where it could still be, one URL per repository currently
// shown as a chip (or the one named in the query). Nothing for any other kind of query.
export function githubTargets(items, parsed, tab) {
  if (parsed.number == null || parsed.words.length > 0) return [];
  const kind = tab === "pr" ? "pull" : "issues";
  const repos = parsed.repo && parsed.repo.includes("/") ? [parsed.repo]
    : chips(items).map((c) => c.repo).filter((r) => !parsed.repo || inRepo({ repo: r }, parsed.repo));
  return repos.map((repo) => ({ repo, url: `https://github.com/${repo}/${kind}/${parsed.number}` }));
}

export const resultsLine = (n) => `${n} ${n === 1 ? "result" : "results"} · Esc to clear`;
