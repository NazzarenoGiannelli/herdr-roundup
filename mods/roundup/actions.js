// The action bar at the bottom of the detail (copy, open, comment, update branch, merge) and the merge-method
// popup. Rendering and the event flows; state lives on the GitHub view (`p`, see main.js), pure
// logic in actions-logic.js, the gh calls in github.js.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { notify, openOverlay, closeOverlay, props, setShared } from "herdr";
import { fetchDetail, fetchRepo, fetchBehind, merge, updateBranch, comment, isDryRun } from "./github.js";
import { updateView, behindKey, wantsBehind } from "./update-logic.js";
import { mergeView, buttonTone, preflight, refText, methodName, menuHeight, canConfirm, effectiveRef, repoKey, MERGE_RETRY_MS, onlyUnknownBlocks, commentProblem } from "./actions-logic.js";
import { capDetail } from "./detail-logic.js";
import { menuLabel } from "./rules.js";

export const SHARED_PICK = "roundup.pick"; // written by the merge popup: { key, method, at }
const MENU_W = 300;
const message = (e) => String(e?.message || e);
// A toast shows one truncated line per field, so whatever must be read in full (a failure, the reason
// a merge was refused) is also kept in the bar, as the item's notice, until another item is selected.
const toast = (title, level, body, timeout = 4000) => notify({ title, body, level, timeout });
function fail(p, key, title, text, level = "error") {
  p.notice = { key, text, level };
  toast(title, level === "error" ? "error" : "warning", text, 10000);
}

// --- copy and open ----------------------------------------------------------------------------

export function copy(cx, what, text) {
  cx.write_to_clipboard(text);
  toast(`Copied ${what}`, "success", text, 1800);
}

// --- merge ------------------------------------------------------------------------------------

// What the merge button shows for the selected PR.
export function viewFor(p, item, key) {
  const entry = p.details.get(key) ?? null;
  // The repository info is the one for the base the detail reports (the list's base only until the detail loads).
  const info = p.repos.get(repoKey(item, entry?.detail ?? null)) ?? null;
  const v = mergeView({
    item, detail: entry?.detail ?? null, repo: info?.info ?? null, repoError: info?.error ?? null, detailError: entry?.error ?? null,
    picked: p.method.get(key) ?? null, armed: p.armed?.key === key ? p.armed : null, merging: p.merging === key, config: p.config,
  });
  if (p.updating === key && v.enabled) return { ...v, enabled: false, reason: "Updating the branch…" };
  return p.merging && p.merging !== key && v.enabled ? { ...v, enabled: false, reason: "Another merge is running" } : v;
}

// The repository's merge settings for the selected PR, loaded once per repository and base.
export function ensureRepoInfo(p, item, cx) {
  const detail = p.details.get(p.selected)?.detail ?? null;
  const id = repoKey(item, detail), base = effectiveRef(item, detail).base;
  if (p.repos.has(id) || !p.shown) return;
  const entry = { info: null, error: null };
  p.repos.set(id, entry);
  cx.spawn(async cx => {
    try { entry.info = await fetchRepo(item.repo, base, p.config); }
    catch (e) { entry.error = message(e); }
    cx.notify();
  });
}

// ⟳ retries the lookups that failed.
export function forgetRepoErrors(p) {
  for (const [id, e] of p.repos) if (e.error) p.repos.delete(id);
}

export function disarm(p, cx) {
  if (!p.armed && !p.updArmed) return;
  p.armed = null; p.updArmed = null; cx.notify();
}

// First click arms (the label becomes the confirm), the second one merges.
export function clickMerge(p, cx) {
  const item = p.selectedItem(), key = p.selected;
  if (!item || p.tab !== "pr" || p.merging) return;
  const v = viewFor(p, item, key);
  if (!v.enabled) return;
  // A confirm within CONFIRM_DELAY_MS of arming is the second click of a double-click: ignored.
  if (v.armed) return canConfirm(p.armed, Date.now()) ? confirmMerge(p, item, key, cx) : undefined;
  const detail = p.details.get(key)?.detail;
  p.notice = null;
  // head and base are the values the default was computed from (the detail's).
  p.armed = { key, method: v.method, draft: v.draft, headOid: detail?.headOid ?? null, head: v.prHead, base: v.prBase, armedAt: Date.now() };
  p.keys.focus();
  cx.notify();
}

// The second click: look again at the PR first. Anything that changed since the label was read
// (CI, conflicts, draft state, new commits, base) aborts with the reason; otherwise gh runs.
function confirmMerge(p, item, key, cx) {
  const armed = p.armed, ref = refText(item), how = methodName(armed.method);
  p.merging = key;
  cx.notify();
  cx.spawn(async cx => {
    try {
      let fresh;
      try {
        fresh = await fetchDetail(item.repo, item.number, "pr");
        // GitHub computes mergeability lazily: when that is the only thing in the way, wait once and look again.
        if (onlyUnknownBlocks(fresh, item)) {
          await new Promise(resolve => cx.timer.after(MERGE_RETRY_MS, () => resolve()));
          fresh = await fetchDetail(item.repo, item.number, "pr");
        }
      } catch (e) { fail(p, key, `Not merged: ${ref}`, `Not merged: couldn't check the pull request again (${message(e)})`, "warning"); return; }
      const entry = p.details.get(key);
      if (entry) { entry.detail = capDetail(fresh); entry.error = null; }
      const why = preflight(armed, fresh, item);
      if (why) { fail(p, key, `Not merged: ${ref}`, `Not merged: ${why}`, "warning"); return; }
      try {
        await merge(item.repo, item.number, armed.method, { draft: armed.draft, headOid: fresh.headOid });
      } catch (e) {
        if (entry) entry.stamp = null; // look at it again: the failure may have changed it
        fail(p, key, `Couldn't merge ${ref}`, `Couldn't merge: ${message(e)}`);
        return;
      }
      toast(isDryRun() ? `Dry run: would merge ${ref}` : `Merged ${ref}`, "success", `(${how})${isDryRun() ? ", nothing was merged" : ""}`, 4000);
      if (!isDryRun()) { p.markSiblingsStale(key, fresh.base ?? item.base); p.behind.clear(); } // their mergeability and distance just changed
      p.removeItem(key, !isDryRun());
    } finally {
      p.merging = null; p.armed = null;
      cx.notify();
    }
  });
}

// ▾: the popup with the methods. Opening it disarms.
export function openMergeMenu(p, cx) {
  const item = p.selectedItem();
  if (!item || p.tab !== "pr") return;
  const v = viewFor(p, item, p.selected);
  if (v.choices.length === 0 || p.merging) return;
  p.armed = null;
  // The bar is at the bottom of the window: the popup opens upward from the pointer, its right edge at the arrow.
  const height = menuHeight(v.choices), at = p.menuPos ? { x: Math.max(8, p.menuPos.x - MENU_W + 16), y: Math.max(8, p.menuPos.y - height - 14) } : "pointer";
  openOverlay({ mod: "roundup", kind: "popup", width: MENU_W, height, at, props: { menu: "merge", key: p.selected, choices: v.choices } });
  cx.notify();
}

// The popup's pick arrives through shared state; it applies to that PR only.
export function applyPick(p, pick) {
  if (!pick || pick.at === p.pickAt) return;
  p.pickAt = pick.at;
  p.method.set(pick.key, pick.method);
  p.armed = null;
}

// --- update branch ----------------------------------------------------------------------------

// How far the selected PR's branch is behind its base: compared once per head commit and base, only
// for the selected PR (one REST call), and again after ⟳ or a merge.
export function ensureBehind(p, item, cx) {
  const detail = p.details.get(p.selected)?.detail ?? null;
  if (!p.shown || !wantsBehind(item, detail)) return;
  const id = behindKey(p.selected, detail.headOid, detail.base);
  if (p.behind.has(id)) return;
  const entry = { value: null, error: null };
  p.behind.set(id, entry);
  cx.spawn(async cx => {
    try { entry.value = await fetchBehind(item.repo, detail.headOid, detail.base); }
    catch (e) { entry.error = message(e); }
    cx.notify();
  });
}

// The comparison of the selected PR as the header and the bar use it ({ count, lastCommitAt }), or null.
export function behindOf(p, item, detail) {
  if (!wantsBehind(item, detail)) return null;
  return p.behind.get(behindKey(`${item.repo}#${item.number}`, detail.headOid, detail.base))?.value ?? null;
}

function updateViewFor(p, item, key) {
  const detail = p.details.get(key)?.detail ?? null;
  return updateView({
    item, detail, behind: behindOf(p, item, detail),
    armed: p.updArmed?.key === key ? p.updArmed : null,
    updating: p.updating === key, busy: Boolean(p.merging) || Boolean(p.updating && p.updating !== key),
  });
}

// First click arms (the label becomes "Confirm update"), the second one updates.
export function clickUpdate(p, cx) {
  const item = p.selectedItem(), key = p.selected;
  if (!item || p.tab !== "pr" || p.updating || p.merging) return;
  const u = updateViewFor(p, item, key);
  if (!u?.enabled) return;
  if (u.armed) return canConfirm(p.updArmed, Date.now()) ? confirmUpdate(p, item, key, cx) : undefined;
  p.notice = null; p.armed = null;
  p.updArmed = { key, headOid: p.details.get(key)?.detail?.headOid ?? null, armedAt: Date.now() };
  p.keys.focus();
  cx.notify();
}

// GitHub refuses the update when the branch moved since it was armed (expected_head_sha), so there is
// no re-check here. The update is asynchronous on GitHub's side: the detail and the list are read again
// a few seconds later, when the new head commit and its CI show up.
const UPDATE_RELOAD_MS = 4000;
function confirmUpdate(p, item, key, cx) {
  const armed = p.updArmed, ref = refText(item);
  p.updating = key; p.updArmed = null;
  cx.notify();
  cx.spawn(async cx => {
    try {
      try { await updateBranch(item.repo, item.number, armed.headOid); }
      catch (e) { fail(p, key, `Couldn't update ${ref}`, `Couldn't update the branch: ${message(e)}`); return; }
      const base = p.details.get(key)?.detail?.base ?? item.base;
      toast(isDryRun() ? `Dry run: would update ${ref}` : `Updated ${ref}`, "success",
        isDryRun() ? "nothing was changed" : `merged ${base} into the branch; CI runs again`, 4000);
      if (isDryRun()) return;
      for (const id of [...p.behind.keys()]) if (id.startsWith(`${key}@`)) p.behind.delete(id);
      cx.timer.after(UPDATE_RELOAD_MS, cx => {
        const entry = p.details.get(key);
        if (entry && !entry.loading) entry.stamp = null;
        p.refresh(cx, false);
        cx.notify();
      });
    } finally {
      p.updating = null;
      cx.notify();
    }
  });
}

// --- comment ----------------------------------------------------------------------------------

export function openComment(p, cx) {
  const item = p.selectedItem(), key = p.selected;
  if (!item) return;
  if (p.comment?.key === key) { p.comment.state.focus(); return; }
  const state = TextareaState.new({ placeholder: "Write a comment…", value: p.drafts.get(key) ?? "" });
  state.set_auto_grow(3, 10);
  state.on("submit", (e, cx) => { if (e?.secondary) sendComment(p, cx); });
  p.comment = { key, kind: p.tab, state, sending: false };
  state.focus();
  cx.notify();
}

// Esc: closes the box and keeps what was typed for this item.
export function closeComment(p, cx) {
  const c = p.comment;
  if (!c) return;
  const text = c.state.value();
  if (text.trim()) p.drafts.set(c.key, text); else p.drafts.delete(c.key);
  c.state.release();
  p.comment = null;
  p.keys.focus();
  cx.notify();
}

export function sendComment(p, cx) {
  const c = p.comment, item = p.selectedItem();
  if (!c || c.sending || !item || c.key !== p.selected) return;
  const body = c.state.value().trim();
  if (!body) return;
  const tooLong = commentProblem(body); // refused before gh is called; the text stays in the box
  if (tooLong) { fail(p, c.key, "Comment not sent", tooLong, "warning"); return; }
  c.sending = true;
  cx.notify();
  const ref = refText(item);
  cx.spawn(async cx => {
    try {
      await comment(c.kind, item.repo, item.number, body);
    } catch (e) {
      c.sending = false;
      fail(p, c.key, `Couldn't comment on ${ref}`, `Couldn't comment: ${message(e)}`);
      cx.notify();
      return;
    }
    toast(isDryRun() ? `Dry run: would comment on ${ref}` : `Comment posted on ${ref}`, "success", undefined, 3000);
    p.drafts.delete(c.key);
    if (p.comment === c) { c.state.release(); p.comment = null; }
    const entry = p.details.get(c.key);
    if (entry && !entry.loading) entry.stamp = null; // the thread is fetched again at once
    cx.notify();
  });
}

// --- the bar ----------------------------------------------------------------------------------

// `tip`: the tooltip, for the buttons that show only an icon (the label is then the icon alone).
const button = (t, id, label, onClick, { off = false, tip = null } = {}) =>
  h_flex().id(id).h(28).px(tip ? 8 : 10).flex_none().items_center().justify_center().rounded(6).border_1().border_color(t.border).text_size(12)
    .when(Boolean(tip), el => el.min_w(28).tooltip(tip))
    .when(off, el => el.text_color(t.dim).opacity(0.6))
    .when(!off, el => el.text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)))
    .child(label);

// GitHub's merge green (the same in its light and dark themes, white text on it).
const GH_GREEN = "#238636";
const GH_GREEN_HOVER = "#2ea043";
const GH_GREEN_EDGE = "#ffffff40";
const WHITE = "#ffffff";
const RADIUS = 6;

function mergeButton(p, t, v) {
  const tone = buttonTone(v);
  const green = tone === "green";
  const main = h_flex().id("gh-merge").h(28).px(12).items_center().gap(6).text_size(12).font_semibold().rounded_l(RADIUS)
    .when(green, el => el.bg(GH_GREEN).text_color(WHITE).hover(s => s.bg(GH_GREEN_HOVER)))
    .when(tone === "neutral", el => el.bg(t.hover).border_1().border_color(t.border).text_color(t.foreground).hover(s => s.bg(t.selected)))
    .when(tone === "armed", el => el.bg(t.background).border_1().border_color(t.ansi3).text_color(t.ansi3))
    .when(tone === "off", el => el.bg(t.hover).text_color(t.dim))
    .when(v.enabled, el => el.cursor_pointer().on_click((_e, cx) => clickMerge(p, cx)))
    .when(v.armed, el => el.on_mouse_down_out((_e, cx) => disarm(p, cx)))
    .child(v.merging ? "Merging…" : v.label);
  const more = v.choices.length > 0 && !v.merging;
  const arrow = div().id("gh-merge-more").w(28).h(28).flex().items_center().justify_center().text_size(12).rounded_r(RADIUS)
    .when(more, el => el.cursor_pointer().on_mouse_down("left", e => { p.menuPos = e.position; }).on_click((_e, cx) => openMergeMenu(p, cx)))
    .when(green, el => el.bg(GH_GREEN).text_color(WHITE).border_l(1).border_color(GH_GREEN_EDGE).when(more, a => a.hover(s => s.bg(GH_GREEN_HOVER))))
    .when(!green, el => el.bg(t.hover).text_color(tone === "off" ? t.dim : t.foreground).border_1().border_color(t.border).when(more, a => a.hover(s => s.bg(t.selected))))
    .when(!more, el => el.opacity(0.5))
    .child("▾");
  return h_flex().flex_none().rounded(RADIUS).child(main).child(arrow);
}

// Neutral like the side buttons; armed in the merge button's armed colours.
function updateButton(p, t, u) {
  return h_flex().id("gh-update").h(28).px(10).flex_none().items_center().rounded(RADIUS).border_1().text_size(12)
    .when(u.armed, el => el.bg(t.background).border_color(t.ansi3).text_color(t.ansi3))
    .when(!u.armed, el => el.border_color(t.border).text_color(u.enabled ? t.muted : t.dim))
    .when(!u.enabled, el => el.opacity(0.6))
    .when(u.enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => clickUpdate(p, cx)))
    .when(u.armed, el => el.on_mouse_down_out((_e, cx) => disarm(p, cx)))
    .child(u.label);
}

function commentBox(p, t) {
  const c = p.comment;
  return v_flex().gap(6)
    .on_key_down((e, cx) => {
      if (e.key === "escape") { cx.stop_propagation(); closeComment(p, cx); }
      else if (e.key === "enter" && (e.modifiers?.control || e.modifiers?.platform)) { cx.stop_propagation(); sendComment(p, cx); }
      // The caret's arrows must not move the list's selection (the panel's key handler is above this box).
      else if (e.key === "up" || e.key === "down") cx.stop_propagation();
    })
    .child(div().px(8).py(6).rounded(6).border_1().border_color(t.border).bg(t.background).child(Textarea.new(c.state).w_full()))
    .child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
      .child(div().flex_1().min_w(0).child(c.sending ? "Sending…" : "Ctrl+Enter to send · Esc to close, the text is kept"))
      .child(button(t, "gh-comment-send", c.sending ? "Sending…" : "Send", cx => sendComment(p, cx), { off: c.sending })));
}

// Under the detail. `null` when nothing is selected.
export function actionBar(p, t) {
  const item = p.selectedItem(), key = p.selected;
  if (!item) return null;
  const isPR = p.tab === "pr";
  // A merged PR (the Merged view) is read-only: copy and open, nothing else.
  const v = isPR && !item.merged ? viewFor(p, item, key) : null;
  // The button states what it will do: anything that changes it since the click needs a new click.
  if (p.armed && (p.armed.key !== key || !v?.armed)) p.armed = null;
  const u = isPR && !item.merged ? updateViewFor(p, item, key) : null;
  if (p.updArmed && (p.updArmed.key !== key || !u?.armed)) p.updArmed = null;
  const note = u?.note ? { text: u.note, color: u.armed ? t.ansi3 : t.dim } : v && (v.merging ? { text: "Merging…", color: t.dim }
    : v.armed ? { text: "Click again to confirm · Esc to cancel", color: t.ansi3 }
    : v.reason ? { text: v.status === "loading" ? v.reason : `Can't merge: ${v.reason}`, color: v.status === "loading" ? t.dim : t.ansi3 } : null);
  return v_flex().id("gh-bar").flex_none().border_t(1).border_color(t.border).px(10).py(8).gap(8)
    .when(isDryRun(), el => el.child(div().text_size(11.5).text_color(t.ansi3).child("Dry run — nothing will be merged")))
    .when(p.comment?.key === key, el => el.child(commentBox(p, t)))
    .when(p.notice?.key === key, el => el.child(div().text_size(11.5).text_color(p.notice.level === "error" ? t.ansi1 : t.ansi3).child(p.notice.text)))
    // What the merge button will do, or why it can't: a line of its own, only when there is something to say.
    .when(Boolean(note), el => el.child(div().text_size(11.5).text_color(note.color).child(note.text)))
    // One row: copy, open and comment on the left, the merge button on the right. When a long label
    // ("Confirm mark ready and squash and merge") doesn't fit, the merge button wraps to its own line.
    .child(h_flex().gap(6).flex_wrap().items_center()
      // Compact, so the merge side has room: the number copies the reference, the others are icons with a tooltip.
      .child(button(t, "gh-copy-ref", `#${item.number}`, cx => copy(cx, "reference", refText(item)), { tip: `Copy ${refText(item)}` }))
      .child(button(t, "gh-copy-url", "🔗", cx => copy(cx, "URL", item.url), { tip: "Copy the link" }))
      .child(button(t, "gh-open", "↗", cx => cx.open_url(item.url), { tip: "Open on GitHub" }))
      .when(!item.merged, el => el.child(button(t, "gh-comment", "💬", cx => openComment(p, cx), { tip: "Comment" })))
      .when(Boolean(v), el => el.child(h_flex().ml_auto().flex_none().gap(6).items_center()
        .when(Boolean(u), g => g.child(updateButton(p, t, u)))
        .child(mergeButton(p, t, v)))));
}

// --- the merge popup (opened with props { menu: "merge", key, choices }) ----------------------------

export function startMergeMenu(p) {
  const { key, choices } = props();
  p.menuMerge = { key, choices };
  p.at = Math.max(0, choices.findIndex(c => c.current));
}

function pick(p, c) {
  if (!c.enabled) return;
  setShared(SHARED_PICK, { key: p.menuMerge.key, method: c.method, at: Date.now() });
  closeOverlay(props().overlay);
}

export function mergeMenu(p, t) {
  const { choices } = p.menuMerge;
  return v_flex().id("roundup-merge-menu").track_focus(p.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
    .on_key_down((e, cx) => {
      if (e.key === "down") p.at = (p.at + 1) % choices.length;
      else if (e.key === "up") p.at = (p.at + choices.length - 1) % choices.length;
      else if (e.key === "enter") return pick(p, choices[p.at]);
      else if (e.key === "escape") return closeOverlay(props().overlay);
      else return;
      cx.notify();
    })
    .children(choices.map((c, i) =>
      h_flex().id(`ghm-method-${c.method}`).flex_none().min_h(31).px(8).py(5).gap(8).rounded(7).items_start().text_color(t.foreground)
        .when(i === p.at && c.enabled, el => el.bg(t.selected))
        .when(c.enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(() => pick(p, c)))
        .when(!c.enabled, el => el.opacity(0.5).cursor_not_allowed())
        .child(div().w(14).flex_none().text_color(t.accent).child(c.current ? "✓" : ""))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().child(menuLabel(c.method)))
          .when(Boolean(c.reason), el => el.child(div().text_size(11).text_color(t.dim).child(c.reason))))))
    .child(div().flex_none().mt(4).px(8).pt(6).pb(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child("The default is what this repository usually does; your pick applies to this PR only."));
}
