// The detail half of the GitHub panel (layout C): the selected item's header, description
// and timeline. Rendering only; state and fetching live in main.js, pure logic in detail-logic.js.
import { div, image } from "gpui-kit";
import { settings } from "herdr";
import { avatarPath } from "./avatars.js";
import { v_flex, h_flex, TextView } from "gpui-base";
import { truncated } from "./model.js";
import { shortRepo, ago } from "./browse.js";
import { MERGED_COLOR, spinner, ciSpinner } from "./list.js";
import { isReviewer } from "./config.js";
import { behindOf } from "./actions.js";
import { behindLine } from "./update-logic.js";
import { checkRows, checkMark, checksOpen, checksSummary, checkTime } from "./live-logic.js";
import { activity, groupOpen, pushedLabel, hasOlderCommits, reviewRows, reviewRowLabel } from "./activity-logic.js";
import { whenLabel, windowTimeline, planBodies, reviewLabel, reviewInput, ciChip, reviewStateLabel, hasOlderActivity, initial, descriptionCap, ENTRY_MAX, threadBudgetFor } from "./detail-logic.js";

const tone = (t, name) => name === "good" ? t.ansi2 : name === "bad" ? t.ansi1 : name === "warn" ? t.ansi3 : t.dim;
const stateColor = (t, s) => s === "success" ? t.ansi2 : s === "failure" ? t.ansi1 : s === "pending" ? t.ansi3 : t.dim;
// Commit hashes in the terminal's font (the person's own setting, JetBrains Mono without one).
const mono = () => settings()?.font_family ?? "JetBrains Mono";

// A row that opens `url` on a click (with a hover and a tooltip); a plain row without one.
const opens = (t, row, url, tip) => url ? row.cursor_pointer().hover(s => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => cx.open_url(url)) : row;

const chip = (t, text, color) => div().flex_none().px(6).h(18).flex().items_center().rounded(4).border_1().border_color(t.border)
  .text_size(10.5).text_color(color ?? t.muted).child(text);

// "2h ago", or "just now" under a minute (ago() says "now").
const since = (iso, now) => { const a = ago(iso, now); return a === "now" ? "just now" : `${a} ago`; };


// `id` must be unique on screen; it is never shown.
const link = (t, id, text, onClick) => div().id(`gh-link-${id}`).cursor_pointer().text_color(t.accent).hover(s => s.text_color(t.foreground))
  .on_click((_e, cx) => onClick(cx)).child(text);

function header(p, t, item, detail) {
  const isPR = p.tab === "pr";
  // The checks and the reviewer's verdict come from the loaded detail (the list only has a rollup state and the last five comments).
  const ci = isPR ? ciChip(item.ci, detail?.checks) : null, review = isPR ? reviewLabel(reviewInput(item, detail), p.config) : null;
  const conflicts = isPR && !item.merged && detail?.mergeable === "CONFLICTING";
  // "15 commits behind staging · last commit Oct 23": how stale the branch and its CI are.
  const behind = isPR && detail ? behindLine(behindOf(p, item, detail), detail.base ?? item.base, p.now) : null;
  return v_flex().flex_none().gap(7)
    .child(div().font_semibold().text_size(14).child(item.title))
    .child(h_flex().gap(6).items_center().flex_wrap().text_size(11.5).text_color(t.dim)
      .child(div().child(`${shortRepo(item.repo)} #${item.number}`))
      .child(h_flex().gap(5).items_center()
        .child(avatar(t, item.author, isReviewer(item.author, p.config), item.avatar, 16))
        .child(div().child(`by ${item.author || "unknown"}`)))
      .when(isPR && item.isDraft, el => el.child(chip(t, "Draft")))
      .when(isPR, el => el.child(div().min_w(0).truncate().child(`${item.head} → ${item.base}`))))
    .when(isPR && Boolean(item.merged), el => el.child(h_flex().gap(6).items_center().flex_wrap().text_size(11.5).text_color(t.dim)
      .child(chip(t, item.method === "merge" ? "Merged · merge commit" : item.method === "squash" ? "Merged · squash" : "Merged", MERGED_COLOR))
      .child(div().child(`by ${item.mergedBy || "unknown"} · ${since(item.mergedAt, p.now)}`))))
    .when(isPR, el => el.child(h_flex().gap(6).items_center().flex_wrap()
      .child(chip(t, ci.text, tone(t, ci.tone)))
      .child(chip(t, review.text, tone(t, review.tone)))
      .when(conflicts, e => e.child(chip(t, "Has conflicts", t.ansi1)))
      .when(Boolean(behind), e => e.child(chip(t, behind, t.ansi3)))
      .when(detail?.additions != null, e => e.child(h_flex().gap(5).text_size(11.5).text_color(t.dim)
        .child(div().text_color(t.ansi2).child(`+${detail.additions}`))
        .child(div().text_color(t.ansi1).child(`−${detail.deletions}`))
        .child(div().child(`· ${detail.changedFiles} ${detail.changedFiles === 1 ? "file" : "files"}`))))))
    .when(item.labels.length > 0, el => el.child(h_flex().gap(4).flex_wrap().children(item.labels.map(l => chip(t, l)))));
}

// The checks: failed first, then running (a spinner), queued (○), then the rest, each with how long
// it ran or has been running; a click opens its run. Open while something runs or failed, one line
// ("CHECKS · 6 passed") when everything passed; the heading flips it. The detail is read again every
// 10 seconds while one runs (main.js followChecks).
function checksList(p, t, key, detail) {
  const rows = checkRows(detail?.checks);
  if (rows.length === 0) return null;
  const open = checksOpen(rows, p.checksToggled.has(key)), now = Date.now();
  return v_flex().flex_none().gap(3)
    .child(h_flex().id(`gh-checks-${key}`).gap(6).items_center().cursor_pointer().text_size(11).text_color(t.dim)
      .hover(s => s.text_color(t.foreground)).on_click((_e, cx) => p.toggleChecks(key, cx))
      .child(div().font_semibold().child("CHECKS"))
      .child(div().min_w(0).truncate().child(checksSummary(rows)))
      .child(div().flex_none().child(open ? "▾" : "▸")))
    .when(open, el => el.children(rows.map((r, i) => {
      const mark = checkMark(r.state, r.phase);
      return opens(t, h_flex().id(`gh-check-${key}-${i}`).gap(6).items_center().text_size(11.5).min_w(0).rounded(4)
        .child(mark === null ? ciSpinner(t).w(12) : div().w(12).flex_none().text_color(stateColor(t, r.state)).child(mark))
        .child(div().flex_1().min_w(0).truncate().text_color(r.state === "failure" ? t.foreground : t.muted).child(r.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(checkTime(r, now))), r.url, "Open the run on GitHub");
    })));
}

// Who is reviewing and where each stands (activity-logic.reviewRows): a review check running, a
// review asked for and not given, then each person's latest verdict.
function reviewList(p, t, key, detail) {
  const rows = reviewRows(detail, p.config);
  if (rows.length === 0) return null;
  return v_flex().flex_none().gap(4)
    .child(div().text_size(11).font_semibold().text_color(t.dim).child("REVIEW"))
    .children(rows.map((r, i) => {
      const label = reviewRowLabel(r.state), busy = r.state === "reviewing";
      const right = busy ? (r.check ?? "") : r.at ? whenLabel(r.at, p.now) : "";
      return opens(t, h_flex().id(`gh-review-${key}-${i}`).gap(6).items_center().text_size(11.5).min_w(0).rounded(4)
        .child(avatar(t, r.who, isReviewer(r.who, p.config), r.avatar, 16))
        .child(div().flex_none().text_color(t.foreground).child(r.who))
        .when(busy, el => el.child(ciSpinner(t)))
        .child(div().flex_1().min_w(0).truncate().text_color(tone(t, label.tone)).child(label.text))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(right)), r.url, "Open the review run on GitHub");
    }));
}

// A markdown block; `id` stays the same for the same text, so the view keeps its state.
function markdown(t, id, text) {
  return TextView.markdown(id, text).selectable(true).text_size(12.5).text_color(t.foreground);
}

function description(p, t, item, detail) {
  const key = `${item.repo}#${item.number}`;
  const capped = truncated(detail.body, descriptionCap(detail));
  const text = capped.text, cut = capped.cut || detail.bodyCut === true; // the cached text is already cut: bodyCut remembers it
  if (!text.trim()) return div().text_size(12).text_color(t.dim).child("No description provided.");
  return v_flex().gap(6).min_w(0)
    .child(markdown(t, `gh-body-${key}`, text))
    .when(cut, el => el.child(h_flex().gap(6).text_size(11.5).text_color(t.dim)
      .child(div().child("Description truncated ·"))
      .child(link(t, `body-${key}`, "Open on GitHub", cx => cx.open_url(item.url)))));
}

// The GitHub picture once it is downloaded (avatars.js), the initial in a circle until then or without one.
function avatar(t, author, reviewer, url, size = 22) {
  const path = avatarPath(url);
  if (path) return image(path).size(size).flex_none().rounded(size / 2);
  return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().text_size(size / 2).font_semibold()
    .bg(reviewer ? t.accent : t.hover).text_color(reviewer ? t.accent_foreground : t.muted).child(initial(author));
}

// One commit: its CI mark, short hash, title; a click opens it on GitHub.
function commitRow(p, t, key, c) {
  const mark = c.ci === "pending" ? ciSpinner(t)
    : div().w(10).flex_none().text_size(10.5).text_color(stateColor(t, c.ci)).child(c.ci === "success" ? "✓" : c.ci === "failure" ? "✗" : "·");
  return opens(t, h_flex().id(`gh-commit-${key}-${c.oid}`).gap(6).items_center().text_size(11.5).min_w(0).rounded(4)
    .child(mark)
    .child(div().flex_none().font_family(mono()).text_size(11).text_color(t.accent).child(c.short))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.title)), c.url, "Open the commit on GitHub");
}

// Commits in a row by one author: "jonas pushed 4 commits · 2h", then the commits. The newest group
// and single commits start open; a click on the heading opens or closes a group.
function commitGroup(p, t, key, g, newest) {
  const many = g.commits.length > 1, open = groupOpen(g, newest, p.pushesToggled(key)), who = g.author || "Someone";
  const head = h_flex().id(`gh-push-${key}-${g.id}`).gap(6).items_center().text_size(11.5).text_color(t.dim).min_w(0)
    .child(avatar(t, who, isReviewer(who, p.config), g.avatar, 16))
    .child(div().min_w(0).truncate().child(`${who} ${pushedLabel(g.commits.length)} · ${whenLabel(g.at, p.now)}`))
    .when(many, el => el.cursor_pointer().hover(s => s.text_color(t.foreground)).on_click((_e, cx) => p.togglePush(key, g.id, cx))
      .child(div().flex_none().child(open ? "▾" : "▸")));
  return v_flex().gap(3).min_w(0).child(head)
    .when(open, el => el.child(v_flex().gap(2).pl(22).min_w(0).children(g.commits.map(c => commitRow(p, t, key, c)))));
}

function entry(p, t, key, plan, item, newest) {
  const { entry: e, index, text, cut, excerpt } = plan;
  if (e.kind === "commits") return commitGroup(p, t, key, e, newest);
  if (e.kind === "forcepush") {
    return div().text_size(11.5).text_color(t.dim).child(`${e.author || "Someone"} force-pushed the branch${e.after ? ` to ${e.after}` : ""} · ${whenLabel(e.at, p.now)}`);
  }
  if (e.kind === "labeled") {
    return div().text_size(11.5).text_color(t.dim).child(`${e.author || "Someone"} added the label ${e.label} · ${whenLabel(e.at, p.now)}`);
  }
  const reviewer = isReviewer(e.author, p.config);
  const review = e.kind === "review" ? reviewStateLabel(e.state) : null;
  return h_flex().gap(9).items_start().p(8).rounded(7).min_w(0)
    .when(reviewer, el => el.bg(t.selected).border_l(2).border_color(t.accent))
    .when(!reviewer, el => el.border_1().border_color(t.border))
    .child(avatar(t, e.author, reviewer, e.avatar))
    .child(v_flex().flex_1().min_w(0).gap(4)
      .child(h_flex().gap(6).items_center().flex_wrap().text_size(11.5)
        .child(div().font_semibold().text_color(reviewer ? t.accent : t.foreground).child(e.author || "unknown"))
        .when(reviewer, el => el.child(chip(t, "reviewer", t.accent)))
        .when(Boolean(review), el => el.child(div().text_color(tone(t, review.tone)).child(review.text)))
        .child(div().text_color(t.dim).child(whenLabel(e.at, p.now))))
      .when(text !== null, el => el.child(markdown(t, `gh-tl-${key}-${index}`, text)))
      // Past the thread's budget: one line, and "Show" brings this entry's body in.
      .when(excerpt !== null && Boolean(excerpt), el => el.child(h_flex().gap(8).items_center().text_size(11.5).min_w(0)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(excerpt))
        .child(link(t, `show-${key}-${index}`, "Show", cx => p.showEntry(key, index, cx)))))
      .when(cut, el => el.child(h_flex().gap(6).text_size(11.5).text_color(t.dim)
        .child(div().child("Comment truncated ·"))
        .child(link(t, `cut-${key}-${index}`, "Open on GitHub", cx => cx.open_url(item.url))))));
}

// The conversation with the branch's commits woven in (activity-logic.activity), oldest first.
function timeline(p, t, key, item, detail) {
  const all = activity(detail.timeline, detail.commits);
  const { shown, hidden } = windowTimeline(all, p.expanded.has(key));
  if (shown.length === 0) return null;
  // The description is spent first: the thread gets what is left of the one render budget.
  const plans = planBodies(shown, p.openedEntries(key), ENTRY_MAX, threadBudgetFor(detail));
  return v_flex().gap(8).min_w(0)
    .child(div().text_size(11).font_semibold().text_color(t.dim).child("ACTIVITY"))
    // The query returns the last 100 entries and the last 100 commits: exactly 100 entries, or more
    // commits than came back, means the thread goes further back.
    .when(hidden === 0 && (hasOlderActivity(detail) || hasOlderCommits(detail)), el => el.child(h_flex().text_size(11.5).child(link(t, `older-${key}`, "Older activity on GitHub", cx => cx.open_url(item.url)))))
    .when(hidden > 0, el => el.child(div().id("gh-earlier").h(26).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .border_1().border_color(t.border).text_size(11.5).text_color(t.muted).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => p.showEarlier(key, cx)).child(`Show earlier (${hidden})`)))
    .children(plans.map(plan => entry(p, t, key, plan, item, plan.index === all.length - 1)));
}

// The bar between the list and the detail: press and drag to resize the list (main.js moves it).
export function divider(p, t, listH) {
  const live = Boolean(p.drag);
  return div().id("gh-divider").h(9).w_full().flex_none().relative().cursor_row_resize().hover(s => s.bg(t.hover))
    .on_mouse_down("left", (e, cx) => p.startDrag(e.position.y, listH, cx))
    .child(div().absolute().left(0).right(0).top(live ? 3 : 4).h(live ? 3 : 1).bg(live ? t.accent : t.border));
}

const placeholder = (t, text) => div().flex_1().min_h(0).p(14).text_size(12).text_color(t.dim).child(text);

// The pane below the divider. `actions` (or null) is the bottom bar's slot, filled by the actions task.
export function detailPane(p, t, actions) {
  const item = p.selectedItem();
  if (!item) return v_flex().id("gh-detail").flex_1().min_h(0).child(placeholder(t, p.tab === "pr" ? "Select a pull request to read it here." : "Select an issue to read it here."));
  const key = `${item.repo}#${item.number}`, entryState = p.detailEntry(), detail = entryState?.detail ?? null;
  const open = p.tab === "pr" && !item.merged;
  const checks = open ? checksList(p, t, key, detail) : null, reviews = open ? reviewList(p, t, key, detail) : null;
  return v_flex().id("gh-detail").flex_1().min_h(0)
    .child(v_flex().id(`gh-scroll-${key}`).flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12)
      .child(header(p, t, item, detail))
      .when(Boolean(checks), el => el.child(checks))
      .when(Boolean(reviews), el => el.child(reviews))
      .when(entryState?.error && !detail, el => el.child(div().text_size(12).text_color(t.ansi1).child(`Couldn't load the details: ${entryState.error} · Press ⟳ to retry.`)))
      .when(entryState?.error && Boolean(detail), el => el.child(div().text_size(11.5).text_color(t.ansi1).child(`Couldn't refresh the details: ${entryState.error} · showing the last version.`)))
      .when(!detail && !entryState?.error, el => el.child(h_flex().gap(8).items_center().text_size(12).text_color(t.dim).child(spinner(t)).child("Loading…")))
      .when(Boolean(detail) && entryState?.loading && !entryState?.live, el => el.child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim).child(spinner(t)).child("Refreshing…")))
      .when(Boolean(detail), el => {
        const log = timeline(p, t, key, item, detail);
        el = el.child(description(p, t, item, detail));
        return log ? el.child(log) : el;
      }))
    .when(Boolean(actions), el => el.child(actions));
}
