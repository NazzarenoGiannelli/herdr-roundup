// Pure helpers for the detail half of the GitHub panel. Imports only ./rules.js, ./config.js and
// ./model.js (loaded by Node tests and by the Herdr runtime).

import { reviewState, checkNames } from "./rules.js";
import { DEFAULT_CONFIG } from "./config.js";
import { truncated } from "./model.js";

export const MAX_TIMELINE = 50;  // entries rendered before "Show earlier (n)"
export const MIN_LIST = 80;      // px, the list never gets smaller than this
export const MAX_LIST_SHARE = 0.6;
export const DEFAULT_LIST_SHARE = 0.45;

// "repo#number" (the selection key) back to its parts; null when it is not one.
export function splitKey(key) {
  const m = /^(.+)#(\d+)$/.exec(String(key ?? ""));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

// Relative time for the timeline: "now", "5m", "2h", "yesterday", "3d", "2mo", "1y".
export function whenLabel(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 2) return "yesterday";
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

// The last `max` entries (or all of them once expanded), each with its index in the full
// thread so a TextView keeps its id when "Show earlier" reveals more above it.
export function windowTimeline(timeline, expanded, max = MAX_TIMELINE) {
  const all = Array.isArray(timeline) ? timeline : [];
  const from = expanded ? 0 : Math.max(0, all.length - max);
  return { shown: all.slice(from).map((entry, i) => ({ entry, index: from + i })), hidden: from };
}

export const maxListHeight = (panelH) => Math.max(MIN_LIST, Math.floor((Number(panelH) || 700) * MAX_LIST_SHARE));
export const defaultListHeight = (panelH) => clampListHeight((Number(panelH) || 700) * DEFAULT_LIST_SHARE, panelH, true);

// Between 80 px and 60 % of the panel. A value that is not a number falls back to the default.
export function clampListHeight(h, panelH, noDefault = false) {
  if (!Number.isFinite(h)) return noDefault ? MIN_LIST : defaultListHeight(panelH);
  return Math.round(Math.min(maxListHeight(panelH), Math.max(MIN_LIST, h)));
}

// The list height while dragging: where it was when the press began, moved by the pointer.
export const dragHeight = (startH, startY, y, panelH) => clampListHeight(startH + (y - startY), panelH);

const TONES = { good: "good", bad: "bad", dim: "dim" };

// Review state, from rules.reviewState: GitHub's decision, else the latest comment by a configured reviewer.
export function reviewLabel(pr, config = DEFAULT_CONFIG) {
  const state = reviewState(pr, config);
  if (state === "changes") return { text: "Changes requested", tone: TONES.bad };
  if (state === "approved") return { text: pr.reviewDecision === "APPROVED" ? "Approved" : "Reviewed", tone: TONES.good };
  return { text: "Not reviewed", tone: TONES.dim };
}

// "CI 3/3 passed", "CI failed: build, lint, e2e +2 more", "CI running 1/3". Skipped and neutral count as passed.
// The failing names are the bar's (rules.checkNames: three at most, each once).
export function ciSummary(checks) {
  const all = Array.isArray(checks) ? checks : [];
  if (all.length === 0) return "No CI";
  const failed = all.filter((c) => c.state === "failure");
  if (failed.length > 0) {
    const names = checkNames(all, "failure");
    return names ? `CI failed: ${names}` : "CI failed";
  }
  const pending = all.filter((c) => c.state === "pending").length;
  if (pending > 0) return `CI running ${all.length - pending}/${all.length}`;
  return `CI ${all.length}/${all.length} passed`;
}

// The CI chip: the checks once the detail is loaded, the list's coarse state before that.
export function ciChip(ci, checks) {
  if (!Array.isArray(checks) || checks.length === 0) return ciLabel(ci);
  const text = ciSummary(checks);
  return { text, tone: text.startsWith("CI failed") ? "bad" : text.startsWith("CI running") ? "warn" : "good" };
}

export function ciLabel(ci) {
  switch (ci) {
    case "success": return { text: "CI passing", tone: "good" };
    case "failure": return { text: "CI failing", tone: "bad" };
    case "pending": return { text: "CI running", tone: "warn" };
    default: return { text: "No CI", tone: "dim" };
  }
}

// What a review entry in the timeline says; null for a pending (unsubmitted) one.
export function reviewStateLabel(state) {
  switch (state) {
    case "APPROVED": return { text: "approved", tone: "good" };
    case "CHANGES_REQUESTED": return { text: "requested changes", tone: "bad" };
    case "COMMENTED": return { text: "reviewed", tone: "dim" };
    case "DISMISSED": return { text: "dismissed", tone: "dim" };
    default: return null;
  }
}

export const initial = (author) => ([...String(author || "")][0] || "?").toUpperCase();

export const ENTRY_MAX = 8000;      // characters of one comment that are rendered
// Characters of bodies rendered across the visible window. Measured (first render, cold): ~42 ms at
// 18 000, ~225 ms at 36 000, ~700 ms at 60 000, and heavier threads made the platform interrupt the render.
export const THREAD_BUDGET = 24000;
// The description is capped at the same size: it is one more block of markdown in the same pane.
export const DESCRIPTION_MAX = THREAD_BUDGET;
const EXCERPT_MAX = 140;

// The thread always keeps room for its newest entry in full: the latest review is often what decides a merge.
export const THREAD_FLOOR = ENTRY_MAX;

// How much of the description is rendered: all of DESCRIPTION_MAX when there is no thread to show,
// otherwise THREAD_BUDGET - THREAD_FLOOR (16 000), so the thread keeps its floor.
export function descriptionCap(detail) {
  const thread = Array.isArray(detail?.timeline) && detail.timeline.some((e) => e.kind !== "labeled" && String(e.body ?? "").trim());
  return thread ? THREAD_BUDGET - THREAD_FLOOR : DESCRIPTION_MAX;
}

// The description and the thread are one render: the description (capped at descriptionCap) is
// spent first, what is left of THREAD_BUDGET goes to the thread.
export function threadBudgetFor(detail) {
  const body = String(detail?.body ?? "");
  return Math.max(0, THREAD_BUDGET - (body.trim() ? Math.min(body.length, descriptionCap(detail)) : 0));
}

// A detail as it is kept in the cache: the description and every comment already cut to what is
// rendered, with the cut remembered (`bodyCut`, `cut`) for the "truncated" notes. Safe to apply twice.
export function capDetail(detail) {
  if (!detail) return detail;
  const body = truncated(detail.body, DESCRIPTION_MAX);
  return {
    ...detail,
    body: body.text,
    bodyCut: detail.bodyCut === true || body.cut,
    timeline: Array.isArray(detail.timeline)
      ? detail.timeline.map((e) => {
        if (typeof e.body !== "string") return e;
        const t = truncated(e.body, ENTRY_MAX);
        return { ...e, body: t.text, cut: e.cut === true || t.cut };
      })
      : detail.timeline,
  };
}

const firstLine = (body) => {
  const line = String(body).split(/\r?\n/).find((l) => l.trim()) ?? "";
  const one = line.trim();
  return one.length > EXCERPT_MAX ? one.slice(0, EXCERPT_MAX) + "…" : one;
};

// What to render for each visible entry: the newest entries get their body (capped at ENTRY_MAX)
// until THREAD_BUDGET characters are spent; older ones become a one-line excerpt, unless the user
// opened that entry (`opened`: set of indexes). Per item: { index, entry, text, cut, excerpt }, in the same order.
export function planBodies(shown, opened = new Set(), entryMax = ENTRY_MAX, budget = THREAD_BUDGET) {
  const out = new Array(shown.length);
  let spent = 0, over = false;
  for (let i = shown.length - 1; i >= 0; i--) {
    const { entry, index } = shown[i];
    const body = entry.kind === "labeled" ? "" : String(entry.body ?? "");
    const plan = { index, entry, text: null, cut: false, excerpt: null };
    if (body.trim()) {
      const capped = truncated(body, entryMax);
      if (opened.has(index) || (!over && spent + capped.text.length <= budget)) {
        plan.text = capped.text; plan.cut = capped.cut || entry.cut === true; spent += capped.text.length;
      } else { over = true; plan.excerpt = firstLine(body); }
    }
    out[i] = plan;
  }
  return out;
}

// The input for rules.reviewState from the loaded detail: its timeline comments (the list only has the last five).
export function reviewInput(pr, detail) {
  if (!detail || !Array.isArray(detail.timeline)) return pr;
  return { ...pr, comments: detail.timeline.filter((e) => e.kind === "comment").map((e) => ({ author: e.author, body: e.body ?? "", createdAt: e.at })) };
}

export const TIMELINE_FETCHED = 100; // timelineItems(last:100) in the detail query
// Exactly that many entries came back: the thread may go on further back, on GitHub.
export const hasOlderActivity = (detail) => Boolean(detail) && Array.isArray(detail.timeline) && detail.timeline.length >= TIMELINE_FETCHED;

// About how far down the detail is, from the wheel: GPUI's delta is negative scrolling down, in
// pixels, or in lines (about 20 px each) for a mouse that reports lines. Never above the top.
export const TOP_AFTER = 600; // px down before the ↑ button shows
export function scrolledBy(before, event) {
  const px = Number(event?.delta?.y) || 0, lines = Number(event?.delta_lines?.y) || 0;
  const dy = px !== 0 ? px : lines * 20;
  return Math.max(0, (Number(before) || 0) - dy);
}
export const showsTop = (down) => (Number(down) || 0) > TOP_AFTER;
