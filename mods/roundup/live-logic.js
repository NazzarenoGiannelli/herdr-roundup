// Pure logic for following CI while it runs: how often to look again, and the check list the detail
// shows. No imports (loaded by Node tests and by the Herdr runtime).
//
// GitHub cannot push to a panel on your machine (that would need a webhook and a server), so "live"
// means looking again often while something is running, and at the normal pace otherwise.

export const LIST_POLL_MS = 60000;   // the list, when nothing in it is running
export const LIVE_LIST_MS = 30000;   // the list, while a pull request in it has CI running
export const LIVE_DETAIL_MS = 10000; // the selected pull request, while its checks run (one GraphQL point a read)

const pending = (c) => c?.state === "pending";

// How long the list waits between looks: faster while an open pull request in it has CI running.
export function listPollMs(items) {
  const running = (Array.isArray(items) ? items : []).some((i) => i && !i.merged && i.ci === "pending");
  return running ? LIVE_LIST_MS : LIST_POLL_MS;
}

// Whether the selected pull request's detail should be read again now: it is loaded (not loading),
// one of its checks is still running, and the last read is at least LIVE_DETAIL_MS old.
export function wantsLiveDetail(entry, now) {
  if (!entry || entry.loading || !entry.detail) return false;
  if (!Array.isArray(entry.detail.checks) || !entry.detail.checks.some(pending)) return false;
  return now - (Number(entry.at) || 0) >= LIVE_DETAIL_MS;
}

// A read that found CI finished where the last one saw it running: the list's dot is out of date.
export const ciSettled = (before, after) => before === "pending" && after != null && after !== "pending";

const ORDER = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 };
const rank = (c) => ORDER[c.state] * 2 + (c.state === "pending" && c.phase === "queued" ? 1 : 0);

// The check list under the header: failed first, then running, then queued, then the rest, each
// group by name; each name and state once. Rows: { name, state, phase, startedAt, completedAt, url }.
export function checkRows(checks) {
  const all = (Array.isArray(checks) ? checks : []).filter((c) => c && c.name);
  const seen = new Set();
  return all
    .filter((c) => { const k = `${c.name}\u0000${c.state}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => {
      const state = ORDER[c.state] === undefined ? "pending" : c.state;
      return { name: c.name, state, phase: state === "pending" ? (c.phase === "queued" ? "queued" : "running") : null,
        startedAt: c.startedAt ?? null, completedAt: c.completedAt ?? null, url: c.url ?? null };
    })
    .sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The list starts open while something runs or has failed; when everything passed it is one line
// ("CHECKS · 6 passed · 1 skipped") that opens on a click. `toggled` flips the default.
export function checksOpen(rows, toggled = false) {
  const busy = (Array.isArray(rows) ? rows : []).some((r) => r.state === "failure" || r.state === "pending");
  return toggled ? !busy : busy;
}

// "2 failed · 1 running · 1 queued · 6 passed · 1 skipped" (only the parts that are there).
export function checksSummary(rows) {
  const n = { failed: 0, running: 0, queued: 0, passed: 0, skipped: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.state === "failure") n.failed++;
    else if (r.state === "pending") n[r.phase === "queued" ? "queued" : "running"]++;
    else if (r.state === "success") n.passed++;
    else n.skipped++;
  }
  return Object.entries(n).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(" · ");
}

// "49s", "1m 25s", "2h 3m".
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// What the right edge of a check row says: "queued", "running 1m 5s", how long a finished one took,
// or nothing when GitHub gave no times (a skipped check, a status from another service).
export function checkTime(row, now) {
  if (!row) return "";
  if (row.state === "pending" && row.phase === "queued") return "queued";
  const start = Date.parse(row.startedAt);
  if (Number.isNaN(start)) return "";
  if (row.state === "pending") return `running ${duration(now - start)}`;
  if (row.state === "skipped") return "";
  const end = Date.parse(row.completedAt);
  return Number.isNaN(end) ? "" : duration(end - start);
}

// The mark before a check's name; null for a running one (the panel draws a spinner there), an empty
// circle for one still queued.
export const checkMark = (state, phase = null) => state === "success" ? "✓" : state === "failure" ? "✗"
  : state === "pending" ? (phase === "queued" ? "○" : null) : "–";
