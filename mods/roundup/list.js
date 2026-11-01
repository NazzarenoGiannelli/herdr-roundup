// The list half of the GitHub panel: tabs, views, repository chips and the rows.
// Rendering only; state and fetching live in main.js, pure logic in browse.js.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, Input } from "gpui-base";
import { VIEWS, keyOf, shortRepo, ago, priority, ROW_H, issueRowHeight, HEADING_H, isHeading } from "./browse.js";

export const MAX_CHIPS = 6;
// Room for an issue row's label chips: panel width minus list padding (8), row padding (20), dot and gap (17), scrollbar (12).
const chipRoom = (p) => (p.size?.width ?? 560) - 57;

// GitHub's "merged" purple: the dot of a merged row instead of its CI.
export const MERGED_COLOR = "#8957e5";
const ciColor = (t, ci) => ci === "success" ? t.ansi2 : ci === "failure" ? t.ansi1 : ci === "pending" ? t.ansi3 : t.dim;
const prioColor = (t, p) => p === "high" ? t.ansi1 : p === "medium" ? t.ansi3 : t.dim;

const pill = (id, label, count, on, t, onClick) =>
  h_flex().id(id).h(24).px(9).gap(5).flex_none().items_center().rounded(12).cursor_pointer().text_size(11.5)
    .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
    .text_color(on ? t.foreground : t.muted).hover(s => s.bg(t.hover))
    .on_click((_e, cx) => onClick(cx))
    .child(label)
    .when(count != null, el => el.child(div().text_color(t.dim).child(String(count))));

export function tabs(p, t) {
  const tab = (id, label, data) => h_flex().id(`gh-tab-${id}`).h(34).px(4).mr(14).gap(6).items_center().cursor_pointer()
    .border_b(2).border_color(p.tab === id ? t.accent : t.background)
    .text_color(p.tab === id ? t.foreground : t.muted).font_semibold()
    .on_click((_e, cx) => p.setTab(id, cx))
    .child(label)
    .child(div().text_size(11.5).text_color(t.dim).font_normal().child(data ? String(data.total) : "–"));
  return h_flex().flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
    .child(tab("pr", "PR", p.prs))
    .child(tab("issue", "Issue", p.issues))
    .child(div().flex_1().min_w(0))
    .child(searchField(p, t));
}

// The search field beside the tabs. `p.searchKey` handles Esc and the arrows (main.js).
export function searchField(p, t) {
  return h_flex().id("gh-search").w(190).h(26).flex_none().px(8).gap(4).items_center().rounded(6).border_1()
    .border_color(p.typing ? t.accent : t.border).cursor_text()
    .on_key_down((e, cx) => p.searchKey(e, cx))
    .child(Input.new(p.search).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground))
    .when(p.query !== "", el => el.child(div().id("gh-search-clear").w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4)
      .cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { p.clearSearch(cx); p.search.focus(); })
      .child("×")));
}

export function viewsRow(p, t, counts) {
  return h_flex().flex_none().px(12).pt(8).gap(6).flex_wrap()
    .children(VIEWS.map(v => pill(`gh-view-${v.id}`, v.label, counts[v.id], p.view === v.id, t, cx => p.setView(v.id, cx))));
}

export function chipsRow(p, t, shown, more) {
  return h_flex().flex_none().px(12).pt(6).gap(6).flex_wrap()
    .child(pill("gh-repo-all", "All repos", null, !p.repo, t, cx => p.setRepo(null, cx)))
    .children(shown.map(c => pill(`gh-repo-${c.repo}`, shortRepo(c.repo), c.count, p.repo === c.repo, t, cx => p.setRepo(p.repo === c.repo ? null : c.repo, cx))))
    .when(more.length > 0, el => el.child(pill("gh-repo-more", "+ more ▾", null, false, t, () => p.openMore(more))));
}

const labelChip = (t, text, color) => div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(t.border)
  .text_size(10).text_color(color ?? t.muted).child(text);

const rowHeight = (p, item) => isHeading(item) ? HEADING_H : p.tab === "issue" ? issueRowHeight(item.labels, chipRoom(p)) : ROW_H;

// A group heading ("READY TO MERGE 3"): small, semibold, dim, like the detail's "ACTIVITY". Not clickable.
function heading(t, row) {
  return h_flex().id(`gh-group-${row.group}`).h(HEADING_H).flex_none().px(10).pb(4).gap(6).items_end()
    .child(div().text_size(11).font_semibold().text_color(t.dim).child(row.heading.toUpperCase()))
    .child(div().text_size(11).text_color(t.dim).child(String(row.count)));
}

function row(p, t, item, selected) {
  const isPR = p.tab === "pr", prio = isPR ? priority(item.labels) : null;
  return h_flex().id(`gh-row-${keyOf(item)}`).h(rowHeight(p, item)).flex_none().px(10).gap(9).items_center().rounded(7).cursor_pointer()
    .when(selected, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
    .when(isPR && item.isDraft, el => el.opacity(0.55))
    // An issue has no CI: an empty spacer keeps titles aligned with the PR tab.
    .child(isPR ? div().size(8).flex_none().rounded(4).bg(item.merged ? MERGED_COLOR : ciColor(t, item.ci)) : div().size(8).flex_none())
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().child(item.title))
        .when(Boolean(prio), el => el.child(labelChip(t, prio, prioColor(t, prio)))))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_none().child(`${shortRepo(item.repo)} #${item.number}`))
        .child(div().flex_none().child(item.merged ? `merged ${ago(item.mergedAt, p.now)}` : ago(item.updatedAt, p.now))))
      // Issues show every label (priority included), wrapping onto more rows.
      .when(!isPR && item.labels.length > 0, el => el.child(h_flex().gap(4).flex_wrap().children(item.labels.map(l => labelChip(t, l))))));
}

// `rows`: PRs and issues, with group headings among them (see browse.groupRows).
export function rowsList(p, t, rows) {
  return div().flex_1().min_h(0).relative().px(4).py(4)
    .child(v_virtual_list("gh-rows", rows.length, rows.map(it => rowHeight(p, it)), i => keyOf(rows[i]),
      range => { p.range = range; return rows.slice(range.start, range.end).map(it => isHeading(it) ? heading(t, it) : row(p, t, it, keyOf(it) === p.selected)); })
      .track_scroll(p.scroll).size_full().on_item_click((key, cx) => p.select(key, cx)))
    .child(Scrollbar.vertical("gh-rows").viewport_from_layout().absolute().inset_0());
}

export function note(t, text, color) {
  return div().flex_none().px(14).pt(8).text_size(11.5).text_color(color ?? t.dim).child(text);
}

export function emptyState(t, text) {
  return div().flex_1().min_h(0).p(14).text_size(12).text_color(t.dim).child(text);
}

// A search with nothing found. For a bare number, the way out is GitHub itself (a closed PR is still one
// step away): "Open on GitHub ▾" lists `owner/repo#n` for the repositories shown as chips.
export function noMatch(p, t, parsed, text, targets) {
  const isNumber = parsed.number != null && parsed.words.length === 0;
  const what = parsed.repo ? `${parsed.repo}#${parsed.number}` : `#${parsed.number}`;
  return v_flex().flex_1().min_h(0).p(14).gap(10).items_start().text_size(12).text_color(t.dim)
    .child(div().child(isNumber ? `No open ${what} · Esc to clear` : `Nothing matches “${text.trim()}” · Esc to clear`))
    .when(targets.length > 0, el => el.child(pill("gh-open-github", "Open on GitHub ▾", null, false, t, cx => p.openOnGitHub(targets, cx))));
}

// A braille spinner drawn from text frames: no picture file, so nothing outside this mod is needed.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (t) => div().w(14).flex_none().text_color(t.muted).frames(SPINNER, 90);

export function refreshButton(p, t) {
  return div().id("gh-refresh").w(28).h(26).flex().items_center().justify_center().rounded(6).cursor_pointer().flex_none()
    .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => p.reload(cx))
    .child(p.loading ? spinner(t) : "⟳");
}

// ⤢: folds the list to the header row so the detail gets the whole panel, and back.
export function collapseButton(p, t) {
  return div().id("gh-collapse").w(28).h(26).flex().items_center().justify_center().rounded(6).cursor_pointer().flex_none()
    .text_color(p.collapsed ? t.foreground : t.muted).when(p.collapsed, el => el.bg(t.selected))
    .hover(s => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => p.toggleList(cx))
    .child("⤢");
}

// The "+ more ▾" popup: the repositories that did not get a chip, with their counts.
export function moreMenu(p, t) {
  const list = p.menuRepos;
  return v_flex().id("roundup-menu").track_focus(p.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).overflow_y_scrollbar()
    .on_key_down((e, cx) => {
      if (e.key === "down") p.at = (p.at + 1) % list.length;
      else if (e.key === "up") p.at = (p.at + list.length - 1) % list.length;
      else if (e.key === "enter") return p.chooseRepo(list[p.at].repo);
      else if (e.key === "escape") return p.closeMenu();
      else return;
      cx.notify();
    })
    .children(list.map((c, i) =>
      h_flex().id(`ghm-${c.repo}`).h(31).flex_none().px(8).gap(9).rounded(7).items_center().text_color(t.foreground).cursor_pointer()
        .when(i === p.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click(() => p.chooseRepo(c.repo))
        .child(div().flex_1().min_w(0).truncate().child(shortRepo(c.repo)))
        .child(div().text_size(11.5).text_color(t.dim).child(String(c.count)))));
}

// The "Open on GitHub ▾" popup: one row per repository, opens that URL.
export function targetsMenu(p, t) {
  const list = p.menuTargets;
  const open = (cx, target) => { cx.open_url(target.url); p.closeMenu(); };
  return v_flex().id("roundup-targets").track_focus(p.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).overflow_y_scrollbar()
    .on_key_down((e, cx) => {
      if (e.key === "down") p.at = (p.at + 1) % list.length;
      else if (e.key === "up") p.at = (p.at + list.length - 1) % list.length;
      else if (e.key === "enter") return open(cx, list[p.at]);
      else if (e.key === "escape") return p.closeMenu();
      else return;
      cx.notify();
    })
    .children(list.map((target, i) =>
      h_flex().id(`ght-${target.repo}`).h(31).flex_none().px(8).gap(9).rounded(7).items_center().text_color(t.foreground).cursor_pointer()
        .when(i === p.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => open(cx, target))
        .child(div().flex_1().min_w(0).truncate().child(target.repo))
        .child(div().text_size(11.5).text_color(t.dim).child("↗"))));
}
