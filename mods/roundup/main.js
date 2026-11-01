// Roundup, the GitHub panel: open pull requests and issues across every repository of the owners in
// config.json (by default the signed-in user and their organizations), through `gh`. Layout C: the
// list on top (list.js), the selected item's detail below (detail.js), a divider between them and the
// action bar at the bottom (actions.js: copy, open, comment, merge). Data layer in github.js, pure
// logic in config/rules/model/browse/detail-logic/actions-logic.js.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, VirtualListScrollHandle, InputState } from "gpui-base";
import { theme, layout, props, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { fetchPRs, fetchIssues, fetchMerged, fetchDetail } from "./github.js";
import { readConfig } from "./config-file.js";
import { DEFAULT_CONFIG, configNote } from "./config.js";
import { isShown } from "./layout-logic.js";
import { stableOrder, byMerged, groupRows, selectable, rowIndex, keyOf, errorLine, parseQuery, search, githubTargets, resultsLine } from "./browse.js";
import { tabs, filtersRow, rowsList, note, emptyState, noMatch, refreshButton, collapseButton, statusMenu, reposMenu, targetsMenu } from "./list.js";
import { normalizeFilters, parseStored, applyFilters, statusCounts, statusRows, statusMenuHeight, repoCounts, repoRows, reposMenuHeight, toggleStatus, toggleRepo, pressCloses } from "./filters.js";
import { detailPane, divider } from "./detail.js";
import { ensureAvatars } from "./avatars.js";
import { splitKey, clampListHeight, dragHeight, capDetail } from "./detail-logic.js";
import { nextKey, dropGone, mergeRetryDelay, wantsMergeRetry, siblingKeys } from "./actions-logic.js";
import { actionBar, mergeMenu, startMergeMenu, ensureRepoInfo, ensureBehind, forgetRepoErrors, applyPick, closeComment, disarm, SHARED_PICK } from "./actions.js";

const MOD = "roundup";                 // this mod's folder: the layout block that hosts the panel names it
const POLL_MS = 60000;
const WATCH_MS = 3000; // a cheap look at visibility (no gh): catches "just shown"
const SHARED_FILTERS = "roundup.filters"; // written by the Status and Repos popups: the filter state and `at` (see filters.js)
const SHARED_MENU = "roundup.menu";       // kept by the open filter popup: { kind, id, open, at } (a second press on its button closes it)
const FILTERS_KEY = "roundup.filters";    // localStorage: the filter state, kept across restarts
const LIST_H_KEY = "roundup.listH";  // localStorage: the list's height in px
const DRAG_GAP_MS = 45;                // the divider repaints at about 20 frames a second
const DETAILS_KEPT = 15;               // details cached for the session, oldest dropped first (bodies are kept cut to what is rendered)
const GONE_MS = 5 * 60000;             // a merged PR is kept out of refreshed lists this long (search lags)

function savedListHeight() {
  try { const n = Number(localStorage.getItem(LIST_H_KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
}

function savedFilters() {
  try { const text = localStorage.getItem(FILTERS_KEY); return text ? parseStored(text) : null; } catch { return null; }
}
function saveFilters(filters) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* not remembered */ }
}

// Fetching only pays off while the panel can be seen: its block is in the layout, no column
// above it is hidden, and every stack above it shows it (see layout-logic.js).
function visible() {
  return isShown(layout(), MOD);
}

const message = (e) => String(e?.message || e);

export default class GitHub extends View {
  init(_props, cx) {
    // Opened as a popup (the Status or Repos filter, "Open on GitHub", or the merge methods): just the
    // menu, nothing else (no fetching, no timers). The filter menus keep their own copy of the state,
    // which they write to a shared key at every tick (see pickFilters).
    if (props()?.menu) {
      this.at = 0;
      this.handle = cx.focus_handle(); this.handle.focus();
      if (props().menu === "merge") startMergeMenu(this);
      else if (props().menu === "github") this.menuTargets = props().targets ?? [];
      else if (props().menu === "status") { this.menuFilters = normalizeFilters(props().filters); this.menuStatus = { counts: props().counts, days: props().days }; }
      else { this.menuFilters = normalizeFilters(props().filters); this.menuRepos = props().repos ?? []; }
      if (this.menuStatus || this.menuRepos) {
        this.menuKind = this.menuStatus ? "status" : "repos";
        setShared(SHARED_MENU, { kind: this.menuKind, id: props().overlay, open: true, at: Date.now() });
      }
      return;
    }
    // config.json is read once, at the start; the first fetch waits for it (refresh). `configNote` is the
    // line shown when the file had a problem.
    this.config = DEFAULT_CONFIG; this.configNote = null;
    setShared(SHARED_MENU, null); // a menu left "open" by the last run (shared state is kept on disk) is not open now
    this.configReady = readConfig().then((r) => { this.config = r.config; this.configNote = configNote(r.problems); return r; });
    this.tab = "pr";
    // Which of the list is shown: statuses and repositories (see filters.js). Kept in localStorage; the
    // popups change it through a shared key, read in render.
    this.filters = savedFilters() ?? normalizeFilters(shared(SHARED_FILTERS));
    this.prs = null; this.issues = null;        // { items, total } of the last good fetch
    this.merged = null;                         // the Merged view's list, fetched only while that view is open
    this.mergedTried = 0;                       // when it was last asked for (0: ask on the next look)
    this.errors = { pr: null, issue: null, merged: null };  // each list's own failure
    this.updated = { pr: null, issue: null, merged: null }; // when each list last loaded
    this.loading = false;
    this.resort = false;                        // re-sort by updatedAt when the next data arrives
    this.selected = null;                       // "repo#number"; kind comes from the tab (see selectedItem)
    this.details = new Map();                   // key -> { detail, error, stamp, loading, tries, retryDue }, the session's cache
    this.detailBusy = null;                     // key being fetched: one detail fetch at a time
    this.expanded = new Set();                  // keys whose whole timeline is shown
    this.opened = new Map();                    // key -> Set of timeline indexes whose long body was opened
    this.repos = new Map();                     // "repo:base" -> { info, error }: merge settings (fetchRepo)
    this.method = new Map();                    // key -> merge method picked for that PR in the popup
    this.pickAt = shared(SHARED_PICK)?.at ?? null;
    this.armed = null;                          // { key, method, draft, headOid, base }: the merge button waits for a second click
    this.merging = null;                        // key being merged: further clicks are ignored
    this.behind = new Map();                    // behindKey -> { value: { count, lastCommitAt }, error }: the selected PR's distance from its base
    this.updArmed = null;                       // { key, headOid, armedAt }: Update branch waits for a second click
    this.updating = null;                       // key whose branch is being updated
    this.comment = null;                        // { key, kind, state, sending }: the open comment box
    this.notice = null;                         // { key, text, level }: a failure kept in the bar (toasts are one truncated line)
    this.drafts = new Map();                    // key -> comment text kept after Esc
    this.gone = new Map();                      // key -> when it was merged here (kept out of refreshed lists)
    this.listH = savedListHeight();             // px, null until the user drags the divider
    this.collapsed = false;                     // the list folded to its header row
    this.drag = null;                           // { y, h } while the divider is held
    this.order = null;                          // keys of the PRs shown, kept across refreshes (before grouping)
    this.rows = [];                             // the items shown, in order: what ↑/↓ and the search move through
    this.display = [];                          // `rows` with the group headings among them: what the list draws and scrolls by
    this.lastAttempt = 0; this.now = Date.now();
    this.filtersAt = shared(SHARED_FILTERS)?.at ?? null;
    this.keys = cx.focus_handle();
    // Search: the field's text decides what the list shows (see render); the filters are left alone.
    this.query = "";                            // the field's text, kept in step by its change event
    this.typing = false;                        // the keyboard is in the field
    this.reveal = false;                        // scroll the list to the top result / the selection on the next render
    this.search = InputState.new({ placeholder: "Search # or title" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.reveal = true; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.searchEnter(cx));
    this.search.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.scroll = VirtualListScrollHandle.new(); this.range = { start: 0, end: 0 };
    // Nothing is fetched while the panel is hidden: the first show is caught by sync().
    this.shown = false;
    this.sync(cx);
    cx.timer.every(WATCH_MS, cx => this.sync(cx));
  }

  // Called by the watch timer and by render. hidden -> visible: refresh and re-sort;
  // visible: refresh once a minute (background polls keep the order); hidden: nothing.
  // `inRender`: cx.notify() is refused during render, so the start of a fetch does not ask for one
  // (this render already reads `loading`; the end of the fetch notifies).
  sync(cx, inRender = false) {
    if (!visible()) { this.shown = false; return; }
    if (!this.shown) { this.shown = true; this.refresh(cx, true, inRender); }
    else if (Date.now() - this.lastAttempt >= POLL_MS) this.refresh(cx, false, inRender);
    // The Merged view just opened (or its list is a minute old): fetch it now, not at the next poll.
    else if (this.wantsMerged() && !this.loading && Date.now() - this.mergedTried >= POLL_MS) this.refresh(cx, false, inRender);
  }

  // One fetch in flight at a time. A failure keeps the last good list and only sets `error`.
  // `resort`: an explicit refresh or the panel shown again; the arriving data is sorted by updatedAt.
  refresh(cx, resort = false, inRender = false) {
    if (resort) this.resort = true;
    if (this.loading) return;
    this.loading = true; this.lastAttempt = Date.now();
    if (!inRender) cx.notify();
    cx.spawn(async cx => {
      const withMerged = this.wantsMerged();
      if (withMerged) this.mergedTried = Date.now();
      const { config } = await this.configReady;
      const [prs, issues, merged] = await Promise.allSettled([fetchPRs(config), fetchIssues(config), withMerged ? fetchMerged(config) : null]);
      if (withMerged) {
        this.errors.merged = merged.status === "rejected" ? message(merged.reason) : null;
        if (merged.status === "fulfilled") { this.merged = merged.value; this.updated.merged = new Date(); }
      }
      for (const [kind, r] of [["pr", prs], ["issue", issues]]) {
        this.errors[kind] = r.status === "rejected" ? message(r.reason) : null;
        if (r.status === "fulfilled") {
          this[kind === "pr" ? "prs" : "issues"] = kind === "pr" ? { ...r.value, items: dropGone(r.value.items, this.gone, Date.now(), GONE_MS) } : r.value;
          this.updated[kind] = new Date();
        }
      }
      if (this.resort && (prs.status === "fulfilled" || issues.status === "fulfilled")) { this.resort = false; this.reset(); }
      this.loading = false; this.now = Date.now();
      cx.notify();
    });
  }

  reset() { this.order = null; }
  // The Merged view shows its own list (PR tab only); everything else reads the open PRs or the issues.
  wantsMerged() { return this.tab === "pr" && this.filters.merged; }
  source() { return this.tab === "issue" ? this.issues : this.wantsMerged() ? this.merged : this.prs; }
  listKind() { return this.wantsMerged() ? "merged" : this.tab; }
  setTab(tab, cx) { if (tab !== this.tab) { this.tab = tab; this.reset(); cx.notify(); } }
  // Another item: the armed merge is dropped, the open comment box closes (its text is kept).
  setSelected(key, cx) {
    if (key === this.selected) return;
    const prev = this.detailEntry();
    if (prev) prev.retryDue = false; // a pending look at mergeability is for the item that was selected
    this.armed = null; this.updArmed = null; this.notice = null;
    if (this.comment) closeComment(this, cx);
    this.selected = key;
  }
  select(key, cx) {
    if (!this.rows.some(r => keyOf(r) === key)) return; // a group heading is never selected
    this.setSelected(key, cx); this.keys.focus(); cx.notify();
  }

  // The PR or issue object behind `selected`, from the current tab's data (null when gone).
  selectedItem() {
    const at = splitKey(this.selected);
    const items = this.source()?.items;
    return at && items ? items.find(i => i.repo === at.repo && i.number === at.number) ?? null : null;
  }
  // { detail, error, stamp, loading, tries, retryDue } for the selected item, or null before its first fetch.
  detailEntry() { return this.selected ? this.details.get(this.selected) ?? null : null; }
  // The loaded Detail (body, mergeable, timeline...) of the selected item; null while loading.
  get detail() { return this.detailEntry()?.detail ?? null; }

  // Loads the selected item's detail when it has none, or when the list says the item changed
  // since (updatedAt). One at a time, so holding ↓ fetches only where the selection comes to rest.
  // A failure is kept for that updatedAt and not retried until ⟳ or a change. Called from render.
  // `retryDue` (set by scheduleMergeRetry) reloads a detail whose mergeability GitHub had not computed,
  // past the "updatedAt unchanged" skip; `tries` counts those reloads for the item and stamp.
  loadDetail(cx, inRender = false) {
    const item = this.selectedItem();
    if (!item || this.detailBusy || !this.shown) return;
    const key = this.selected, old = this.details.get(key);
    const retry = Boolean(old?.retryDue) && old.stamp === item.updatedAt;
    if (old && old.stamp === item.updatedAt && !retry) return;
    const entry = { detail: old?.detail ?? null, error: null, stamp: item.updatedAt, loading: true, tries: retry ? (old.tries ?? 0) + 1 : 0, retryDue: false };
    this.details.delete(key); this.details.set(key, entry);
    for (const k of this.details.keys()) { if (this.details.size <= DETAILS_KEPT) break; if (k !== key) this.details.delete(k); }
    this.detailBusy = key;
    forgetRepoErrors(this); // a failed repository lookup is not kept: this load (and its render) asks again
    if (!inRender) cx.notify();
    const kind = this.tab;
    cx.spawn(async cx => {
      try { entry.detail = capDetail(await fetchDetail(item.repo, item.number, kind)); }
      catch (e) { entry.error = message(e); }
      entry.loading = false; this.detailBusy = null;
      if (!entry.error && wantsMergeRetry(entry.detail, entry.tries)) this.scheduleMergeRetry(key, entry, cx);
      cx.notify();
    });
  }

  // GitHub computes a PR's mergeability lazily: the first read can say UNKNOWN. Look again after
  // mergeRetryDelay (at most MERGE_RETRIES times, see loadDetail). If this load is still the cached one,
  // the reload is marked due; it runs now when the item is selected and the panel visible, otherwise
  // when the item is next selected or the panel shown (loadDetail waits for both).
  scheduleMergeRetry(key, entry, cx) {
    cx.timer.after(mergeRetryDelay(entry.tries), cx => {
      if (this.details.get(key) !== entry) return;
      entry.retryDue = true;
      if (this.selected === key && visible()) cx.notify();
    });
  }

  // After a merge into `base`: the other cached PRs of that repository and base are out of date
  // (mergeability, CI): they reload when selected.
  markSiblingsStale(merged, base) {
    const baseOf = (k) => this.details.get(k)?.detail?.base ?? this.prs?.items.find(i => keyOf(i) === k)?.base ?? null;
    for (const k of siblingKeys([...this.details.keys()], merged, base, baseOf)) this.details.get(k).stamp = null;
  }

  // ⟳: the list, and the selected item's detail with it.
  reload(cx) {
    const entry = this.detailEntry();
    if (entry && !entry.loading) entry.stamp = null;
    forgetRepoErrors(this);
    this.behind.clear(); // the base may have moved
    this.refresh(cx, true);
    cx.notify();
  }
  showEarlier(key, cx) { this.expanded.add(key); cx.notify(); }
  openedEntries(key) { return this.opened.get(key) ?? new Set(); }
  showEntry(key, index, cx) { this.opened.set(key, this.openedEntries(key).add(index)); cx.notify(); }
  toggleList(cx) { this.collapsed = !this.collapsed; this.drag = null; cx.notify(); }

  // The divider: pressed, dragged (the pointer moves over the panel), released anywhere on it.
  // A long description is re-parsed on every render (frames took up to 100 ms on 20 000 characters),
  // so the drag repaints at most every DRAG_GAP_MS; the release applies the exact last position.
  startDrag(y, h, cx) { this.drag = { y, h, last: y, at: 0 }; cx.notify(); }
  dragTo(y, cx) {
    if (!this.drag) return;
    this.drag.last = y;
    const now = Date.now();
    if (now - this.drag.at < DRAG_GAP_MS) return;
    this.drag.at = now;
    this.listH = dragHeight(this.drag.h, this.drag.y, y, this.size?.height);
    cx.notify();
  }
  endDrag(cx) {
    if (!this.drag) return;
    this.listH = dragHeight(this.drag.h, this.drag.y, this.drag.last, this.size?.height);
    this.drag = null;
    try { localStorage.setItem(LIST_H_KEY, String(Math.round(this.listH))); } catch { /* not remembered */ }
    cx.notify();
  }

  // After a merge: the row leaves the list and the next one is selected. `remember`: keep it out of
  // refreshed lists for a while (GitHub's search lags behind a merge).
  removeItem(key, remember = true) {
    const next = nextKey(this.rows.map(keyOf), key);
    if (this.prs) this.prs = { ...this.prs, items: this.prs.items.filter(i => keyOf(i) !== key), total: Math.max(0, this.prs.total - 1) };
    this.order = this.order?.filter(k => k !== key) ?? null;
    if (remember) this.gone.set(key, Date.now());
    this.details.delete(key); this.method.delete(key); this.drafts.delete(key);
    if (this.comment?.key === key) { this.comment.state.release(); this.comment = null; }
    if (this.selected === key) this.selected = next;
    this.mergedTried = 0; // the Merged view asks again the next time it is open (search may still lag a little)
    this.keys.focus();
  }

  // --- the filter dropdowns ---
  // The panel side: the Status and Repos buttons open a popup with the state and the numbers as props.
  // A second press on the same button closes its menu (SHARED_MENU is kept by the popup: see init and close).
  // Both menus open under their button (p.menuAnchor, set on the press; see list.js).
  pressClosesMenu(kind) {
    const menu = shared(SHARED_MENU);
    if (!pressCloses(menu, kind, Date.now())) return false;
    if (menu.open && menu.id) closeOverlay(menu.id);
    setShared(SHARED_MENU, { ...menu, open: false, at: 0 }); // the next press opens it again
    return true;
  }
  openStatus(_cx) {
    if (this.pressClosesMenu("status")) return;
    const counts = statusCounts(this.prs?.items ?? [], this.merged?.items ?? null, this.filters.repos, this.config);
    const days = this.config.mergedDays;
    const rows = statusRows(this.filters, counts, days);
    openOverlay({ mod: "roundup", kind: "popup", width: 270, height: statusMenuHeight(rows), at: this.menuAnchor ?? "pointer", props: { menu: "status", filters: this.filters, counts, days } });
  }
  openRepos(_cx) {
    if (this.pressClosesMenu("repos")) return;
    const repos = repoCounts(this.source()?.items ?? [], this.filters.repos);
    openOverlay({ mod: "roundup", kind: "popup", width: 260, height: reposMenuHeight(repoRows(repos, this.filters.repos)), at: this.menuAnchor ?? "pointer", props: { menu: "repos", filters: this.filters, repos } });
  }
  // The popup side: a tick changes the popup's own copy and is written to the shared key, which the
  // panel reads in render. The popup stays open.
  statusRows() { return statusRows(this.menuFilters, this.menuStatus.counts, this.menuStatus.days); }
  reposRows() { return repoRows(this.menuRepos, this.menuFilters.repos); }
  toggle(row, cx) {
    this.pickFilters(this.menuStatus ? toggleStatus(this.menuFilters, row) : toggleRepo(this.menuFilters, row), cx);
  }
  pickFilters(next, cx) {
    this.menuFilters = next;
    setShared(SHARED_FILTERS, { ...next, at: Date.now() });
    cx.notify();
  }
  closeMenu() { closeOverlay(props().overlay); }
  // A filter menu says it closed (Esc, a press outside, its button pressed again): see pressClosesMenu.
  async close(_cx) {
    if (!this.menuKind) return;
    const menu = shared(SHARED_MENU);
    if (menu?.kind === this.menuKind && menu.id === props()?.overlay) setShared(SHARED_MENU, { ...menu, open: false, at: Date.now() });
  }

  // --- search ---
  // Esc, by where the keyboard is. In the field: clears the text, and with the field empty leaves it
  // (a second Esc). In the list: cancels an armed merge first, otherwise clears the search.
  // The comment box keeps its own Esc (it closes first, whatever else is going on).
  clearSearch(cx) {
    this.search.set_value(""); this.query = ""; this.reveal = true;
    cx.notify();
  }
  focusSearch(cx) {
    disarm(this, cx); // the field takes Esc: an armed merge's "Esc to cancel" would no longer be true
    if (this.collapsed) {
      // The field is not drawn while the list is folded: unfold, and focus once it is there.
      this.collapsed = false; cx.notify();
      cx.timer.after(60, () => this.search.focus());
    } else this.search.focus();
  }
  searchKey(e, cx) {
    if (e.key === "escape") {
      cx.stop_propagation();
      if (this.query !== "") this.clearSearch(cx); else this.keys.focus();
    } else if (e.key === "down") {
      cx.stop_propagation();
      this.searchDown(cx);
    } else if (e.key === "up") cx.stop_propagation(); // the arrows are not the list's while typing
  }
  // ↓: into the results. The first result when the selection is not one of them, else the next one.
  searchDown(cx) {
    if (!this.rows.length) return;
    this.keys.focus();
    if (this.rows.some(r => keyOf(r) === this.selected)) this.step(1, cx);
    else { this.setSelected(keyOf(this.rows[0]), cx); this.reveal = true; cx.notify(); }
  }
  // Enter: the first result becomes the selection (its detail loads); the keyboard stays in the field.
  // With no result for a bare number: GitHub (straight away when only one repository could have it).
  searchEnter(cx) {
    if (this.query.trim() === "") return;
    if (this.rows.length) { this.setSelected(keyOf(this.rows[0]), cx); this.reveal = true; cx.notify(); return; }
    const targets = githubTargets(this.source()?.items ?? [], parseQuery(this.query), this.tab);
    if (targets.length) this.openOnGitHub(targets, cx);
  }
  openOnGitHub(targets, cx) {
    if (targets.length === 1) return cx.open_url(targets[0].url);
    openOverlay({ mod: "roundup", kind: "popup", width: 300, height: Math.min(targets.length, 12) * 31 + 12, props: { menu: "github", targets } });
  }

  step(delta, cx) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex(r => keyOf(r) === this.selected);
    const next = i < 0 ? (delta > 0 ? 0 : this.rows.length - 1) : Math.min(this.rows.length - 1, Math.max(0, i + delta));
    this.setSelected(keyOf(this.rows[next]), cx);
    // Keep the row on screen; the edge rows of the range may be cut off.
    // `range` counts the headings too, so the index is the one in `display`.
    const at = rowIndex(this.display, keyOf(this.rows[next]));
    if (at <= this.range.start || at >= this.range.end - 1) this.scroll.scroll_to_item(at, "center");
    cx.notify();
  }

  render(cx) {
    const t = theme();
    if (this.menuStatus) return statusMenu(this, t);
    if (this.menuRepos) return reposMenu(this, t);
    if (this.menuTargets) return targetsMenu(this, t);
    if (this.menuMerge) return mergeMenu(this, t);
    // A tick in the Status or Repos popup arrives through shared state.
    const picked = shared(SHARED_FILTERS);
    if (picked && picked.at !== this.filtersAt) { this.filtersAt = picked.at; this.filters = normalizeFilters(picked); saveFilters(this.filters); this.reset(); }
    applyPick(this, shared(SHARED_PICK));
    this.sync(cx, true);

    const lookBack = this.wantsMerged();
    const data = this.source();
    const items = data?.items ?? [];
    // Searching covers the whole tab (the filters are ignored, but kept for when the field is cleared);
    // its order is the ranking, so the stable order of the browsing list is left as it was.
    const searching = this.query.trim() !== "";
    // The open PRs are grouped by whose move it is (headings among the rows); searching, the Merged
    // list and the issues are one flat list. The filters decide which rows (and so which headings) are there.
    const filtered = searching ? items : applyFilters(items, this.filters, { tab: this.tab, config: this.config });
    // `rows` never holds a heading: the selection skips them.
    if (searching) this.display = search(items, this.query);
    else if (lookBack) this.display = byMerged(filtered);
    else {
      const ordered = stableOrder(filtered, this.order);
      this.order = ordered.map(keyOf);
      this.display = this.tab === "pr" ? groupRows(ordered, this.config) : ordered;
    }
    this.rows = selectable(this.display);
    if (this.reveal) {
      this.reveal = false;
      // Searching: the best result is on top. Cleared: back to where the selection is.
      const at = searching ? -1 : rowIndex(this.display, this.selected);
      if (this.display.length) this.scroll.scroll_to_item(Math.max(0, at), at >= 0 ? "center" : "top");
    }

    const noun = this.tab === "pr" ? "pull requests" : "issues";
    const days = this.config.mergedDays;
    const span = `${noun} merged in the last ${days === 1 ? "day" : `${days} days`}`;
    const pad = (n) => String(n).padStart(2, "0");
    const when = this.updated[this.listKind()];
    const clock = when ? `Updated ${pad(when.getHours())}:${pad(when.getMinutes())}` : "";
    const error = this.errors[this.listKind()];
    const listH = clampListHeight(this.listH ?? NaN, this.size?.height);
    this.loadDetail(cx, true);
    const sel = this.tab === "pr" ? this.selectedItem() : null;
    if (sel && !sel.merged) { ensureRepoInfo(this, sel, cx); ensureBehind(this, sel, cx); }
    const problem = errorLine(this.listKind(), error, Boolean(data));
    // The pictures of the selected item's author and of everyone in its thread (downloaded once per run).
    const shownItem = this.selectedItem();
    if (shownItem) ensureAvatars([shownItem.avatar, ...(this.detail?.timeline ?? []).map(e => e.avatar)], cx);

    return v_flex().id("github").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs((this.size?.width ?? 0) - size.width) >= 1 || Math.abs((this.size?.height ?? 0) - size.height) >= 1) { this.size = size; cx.notify(); }
      })
      .on_mouse_move((e, cx) => this.dragTo(e.position.y, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .track_focus(this.keys)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.step(1, cx);
        else if (e.key === "up") this.step(-1, cx);
        else if (e.key === "escape") { if (this.armed || this.updArmed) disarm(this, cx); else if (this.query !== "") this.clearSearch(cx); }
        // Ctrl+F anywhere in the panel, `/` only when the list itself has the keyboard (not while typing in a box).
        else if ((e.key === "f" && (e.modifiers?.control || e.modifiers?.platform))
          || ((e.key === "/" || e.key_char === "/") && !e.modifiers?.control && !e.modifiers?.alt && !e.modifiers?.platform && this.keys.is_focused() && !this.typing && !this.comment)) {
          cx.stop_propagation();
          this.focusSearch(cx);
        }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("GitHub"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11.5).text_color(t.dim).child(clock))
        .child(collapseButton(this, t))
        .child(refreshButton(this, t)))
      .when(!this.collapsed, el => el.child(v_flex().h(listH).flex_none().min_h(0).overflow_hidden()
        .child(tabs(this, t))
        .when(Boolean(this.tab === "pr" ? this.prs : this.issues) && !searching, e => e.child(filtersRow(this, t))) // stays while the Merged list loads
        .when(searching && this.rows.length > 0, e => e.child(note(t, resultsLine(this.rows.length))))
        .when(Boolean(problem), e => e.child(note(t, problem, t.ansi1)))
        .when(Boolean(this.configNote), e => e.child(note(t, this.configNote, t.ansi3)))
        .when(Boolean(data?.warning), e => e.child(note(t, `Some results may be missing: ${data.warning}`, t.ansi3)))
        .when(Boolean(data) && data.total > items.length, e => e.child(note(t, `Showing ${items.length} of ${data.total} ${lookBack ? span : `open ${noun}`}`)))
        .child(this.rows.length > 0
          ? rowsList(this, t, this.display)
          : !data ? emptyState(t, error ? "Press ⟳ to retry." : "Loading…")
          : searching ? noMatch(this, t, parseQuery(this.query), this.query, githubTargets(items, parseQuery(this.query), this.tab))
          : emptyState(t, lookBack ? (items.length === 0 ? `No ${span}` : `No ${span} in ${this.filters.repos.length === 1 ? "this repository" : "these repositories"}`)
            : items.length === 0 ? `No open ${noun}` : `No ${noun} match these filters`)))
        .child(divider(this, t, listH)))
      .child(detailPane(this, t, actionBar(this, t)));
  }
}
