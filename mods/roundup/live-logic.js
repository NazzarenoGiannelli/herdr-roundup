// Pure logic for following CI while it runs: how often to look again, and the check list the detail
// shows. No imports (loaded by Node tests and by the Herdr runtime).
//
// GitHub cannot push to a panel on your machine (that would need a webhook and a server), so "live"
// means looking again often while something is running, and at the normal pace otherwise.

export const LIST_POLL_MS = 60000;   // the list, when nothing in it is running
export const LIVE_LIST_MS = 30000;   // the list, while a pull request in it has CI running
export const LIVE_DETAIL_MS = 15000; // the selected pull request, while its checks run

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

// The check list under the header, shown only while something runs or has failed (all green says it
// in the CI chip). Failed first, then running, then the rest, each group by name; each name once.
export function checkRows(checks) {
  const all = (Array.isArray(checks) ? checks : []).filter((c) => c && c.name);
  if (!all.some((c) => c.state === "failure" || c.state === "pending")) return [];
  const seen = new Set();
  return all
    .filter((c) => { const k = `${c.name}\u0000${c.state}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => ({ name: c.name, state: ORDER[c.state] === undefined ? "pending" : c.state }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The mark before a check's name; null for a running one (the panel draws a spinner there).
export const checkMark = (state) => state === "success" ? "✓" : state === "failure" ? "✗" : state === "pending" ? null : "–";
