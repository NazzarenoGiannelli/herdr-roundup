import { test } from "node:test";
import assert from "node:assert/strict";
import { truncated } from "../model.js";
import { whenLabel, windowTimeline, clampListHeight, defaultListHeight, dragHeight, reviewLabel, ciLabel, reviewStateLabel, initial, splitKey, MIN_LIST, MAX_TIMELINE, ciSummary, ciChip, planBodies, reviewInput, hasOlderActivity, ENTRY_MAX, THREAD_BUDGET, DESCRIPTION_MAX, threadBudgetFor, capDetail, descriptionCap, THREAD_FLOOR, scrolledBy, showsTop, TOP_AFTER } from "../detail-logic.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600e3, D = 24 * H;

test("whenLabel: minutes, hours, yesterday, days, months", () => {
  assert.equal(whenLabel(ago(20e3), NOW), "now");
  assert.equal(whenLabel(ago(5 * 60e3), NOW), "5m");
  assert.equal(whenLabel(ago(2 * H), NOW), "2h");
  assert.equal(whenLabel(ago(23 * H), NOW), "23h");
  assert.equal(whenLabel(ago(24 * H), NOW), "yesterday");
  assert.equal(whenLabel(ago(47 * H), NOW), "yesterday");
  assert.equal(whenLabel(ago(3 * D), NOW), "3d");
  assert.equal(whenLabel(ago(65 * D), NOW), "2mo");
  assert.equal(whenLabel("nonsense", NOW), "");
  assert.equal(whenLabel(ago(-5000), NOW), "now"); // a clock a little behind GitHub's
});

const entries = (n) => Array.from({ length: n }, (_, i) => ({ kind: "comment", author: "a", at: String(i), body: "" }));

test("windowTimeline shows the last 50 and counts the rest", () => {
  const w = windowTimeline(entries(120), false);
  assert.equal(MAX_TIMELINE, 50);
  assert.equal(w.shown.length, 50);
  assert.equal(w.hidden, 70);
  assert.equal(w.shown[0].index, 70);            // index in the full thread, for stable ids
  assert.equal(w.shown[49].entry.at, "119");     // time order kept
});

test("windowTimeline: short threads and the expanded thread show everything", () => {
  assert.deepEqual(windowTimeline(entries(50), false).hidden, 0);
  assert.equal(windowTimeline(entries(3), false).shown.length, 3);
  const all = windowTimeline(entries(120), true);
  assert.equal(all.shown.length, 120);
  assert.equal(all.hidden, 0);
  assert.equal(windowTimeline(null, false).shown.length, 0);
});

test("clampListHeight keeps the list between 80 px and 60 % of the panel", () => {
  assert.equal(MIN_LIST, 80);
  assert.equal(clampListHeight(10, 800), 80);
  assert.equal(clampListHeight(300, 800), 300);
  assert.equal(clampListHeight(700, 800), 480);
  assert.equal(clampListHeight(200, 100), 80);   // a tiny panel never goes below the minimum
  assert.equal(clampListHeight(NaN, 800), defaultListHeight(800));
});

test("defaultListHeight is a clamped share of the panel", () => {
  assert.equal(defaultListHeight(800), 360);
  assert.equal(defaultListHeight(100), 80);
  assert.equal(defaultListHeight(undefined), defaultListHeight(700));
});

test("dragHeight follows the pointer from where the drag started, clamped", () => {
  assert.equal(dragHeight(300, 500, 540, 800), 340);
  assert.equal(dragHeight(300, 500, 400, 800), 200);
  assert.equal(dragHeight(300, 500, 2000, 800), 480);
  assert.equal(dragHeight(300, 500, -2000, 800), 80);
});

const CLAUDE = { reviewers: ["claude"] };
test("reviewLabel: GitHub's decision, a reviewer's comment, or nothing", () => {
  assert.deepEqual(reviewLabel({ reviewDecision: "APPROVED", comments: [] }), { text: "Approved", tone: "good" });
  assert.deepEqual(reviewLabel({ reviewDecision: "CHANGES_REQUESTED", comments: [] }), { text: "Changes requested", tone: "bad" });
  assert.deepEqual(reviewLabel({ reviewDecision: null, comments: [{ author: "claude", body: "LGTM", createdAt: "2026-10-30T10:00:00Z" }] }, CLAUDE), { text: "Reviewed", tone: "good" });
  assert.deepEqual(reviewLabel({ reviewDecision: null, comments: [{ author: "claude", body: "LGTM", createdAt: "2026-10-30T10:00:00Z" }] }), { text: "Not reviewed", tone: "dim" }, "no reviewer is named by default");
  assert.deepEqual(reviewLabel({ reviewDecision: null, comments: [{ author: "claude", body: "CHANGES REQUESTED: x", createdAt: "2026-10-30T10:00:00Z" }] }, CLAUDE), { text: "Changes requested", tone: "bad" });
  assert.deepEqual(reviewLabel({ reviewDecision: null, comments: [] }), { text: "Not reviewed", tone: "dim" });
});

test("reviewLabel: whose comment counts comes from the config", () => {
  const byPriya = { reviewDecision: null, comments: [{ author: "priya", body: "LGTM", createdAt: "2026-10-30T10:00:00Z" }] };
  assert.deepEqual(reviewLabel(byPriya), { text: "Not reviewed", tone: "dim" });
  assert.deepEqual(reviewLabel(byPriya, { reviewers: ["priya"] }), { text: "Reviewed", tone: "good" });
});

test("ciLabel", () => {
  assert.equal(ciLabel("success").text, "CI passing");
  assert.equal(ciLabel("failure").text, "CI failing");
  assert.equal(ciLabel("pending").text, "CI running");
  assert.equal(ciLabel("none").text, "No CI");
  assert.equal(ciLabel(undefined).text, "No CI");
});

test("reviewStateLabel for a review entry", () => {
  assert.equal(reviewStateLabel("APPROVED").text, "approved");
  assert.equal(reviewStateLabel("CHANGES_REQUESTED").text, "requested changes");
  assert.equal(reviewStateLabel("COMMENTED").text, "reviewed");
  assert.equal(reviewStateLabel("DISMISSED").text, "dismissed");
  assert.equal(reviewStateLabel("PENDING"), null);
});

test("initial and splitKey", () => {
  assert.equal(initial("claude"), "C");
  assert.equal(initial(""), "?");
  assert.equal(initial("dependabot"), "D");
  assert.deepEqual(splitKey("acme/widgets#130"), { repo: "acme/widgets", number: 130 });
  assert.equal(splitKey("nope"), null);
  assert.equal(splitKey(null), null);
});

const ck = (name, state) => ({ name, state });

test("ciSummary: all passed, skipped and neutral count as passed", () => {
  assert.equal(ciSummary([ck("a", "success"), ck("b", "success"), ck("c", "success")]), "CI 3/3 passed");
  assert.equal(ciSummary([ck("a", "success"), ck("b", "skipped"), ck("c", "neutral")]), "CI 3/3 passed");
});

test("ciSummary: names the failures, three at most then +n more, each name once (the bar's rule)", () => {
  assert.equal(ciSummary([ck("a", "success"), ck("build", "failure")]), "CI failed: build");
  assert.equal(ciSummary([ck("build", "failure"), ck("lint", "failure"), ck("x", "success")]), "CI failed: build, lint");
  assert.equal(ciSummary([ck("build", "failure"), ck("lint", "failure"), ck("e2e", "failure"), ck("t", "failure"), ck("u", "failure")]), "CI failed: build, lint, e2e +2 more");
  assert.equal(ciSummary([ck("build", "failure"), ck("build", "failure"), ck("lint", "failure")]), "CI failed: build, lint", "two workflows with a build job");
  assert.equal(ciSummary([ck("build", "failure"), ck("w", "pending")]), "CI failed: build"); // a failure wins over running
});

test("ciSummary: running shows how many are done", () => {
  assert.equal(ciSummary([ck("a", "success"), ck("b", "pending"), ck("c", "pending")]), "CI running 1/3");
  assert.equal(ciSummary([ck("a", "skipped"), ck("b", "success"), ck("c", "pending")]), "CI running 2/3");
});

test("ciSummary: nothing to summarise", () => {
  assert.equal(ciSummary([]), "No CI");
  assert.equal(ciSummary(null), "No CI");
});

test("ciChip uses the checks when loaded, the list's state before", () => {
  assert.deepEqual(ciChip("success", [ck("a", "success")]), { text: "CI 1/1 passed", tone: "good" });
  assert.deepEqual(ciChip("success", [ck("a", "failure")]), { text: "CI failed: a", tone: "bad" });
  assert.deepEqual(ciChip("pending", [ck("a", "pending")]), { text: "CI running 0/1", tone: "warn" });
  assert.deepEqual(ciChip("failure", null), { text: "CI failing", tone: "bad" });
  assert.deepEqual(ciChip("none", []), { text: "No CI", tone: "dim" });
});

const item = (index, body, kind = "comment") => ({ index, entry: { kind, author: "a", at: String(index), body } });

test("planBodies: every body is capped per entry", () => {
  assert.equal(ENTRY_MAX, 8000);
  const [p] = planBodies([item(0, "x".repeat(9000))], new Set());
  assert.equal(p.text.length, 8000);
  assert.equal(p.cut, true);
  assert.equal(p.excerpt, null);
});

test("planBodies: newest entries get full bodies, older ones past the budget become excerpts", () => {
  assert.equal(THREAD_BUDGET, 24000);
  const shown = Array.from({ length: 10 }, (_, i) => item(i, `line one of ${i}
second line ` + "y".repeat(8000)));
  const plan = planBodies(shown, new Set());
  const full = plan.filter((p) => p.text !== null);
  assert.equal(full.length, 3, "24 000 characters of bodies, 8 000 each");
  assert.ok(full.reduce((n, p) => n + p.text.length, 0) <= THREAD_BUDGET);
  assert.equal(plan[9].excerpt, null);        // the newest is full
  assert.equal(plan[0].text, null);            // the oldest is an excerpt
  assert.equal(plan[0].excerpt, "line one of 0"); // first line only
  assert.deepEqual(plan.map((p) => p.index), shown.map((s) => s.index)); // order and indexes kept
});

test("planBodies: an opened entry is full, long excerpts are cut, empty bodies and labels have none", () => {
  const shown = [item(0, "z".repeat(70000)), ...Array.from({ length: 8 }, (_, i) => item(i + 1, "a".repeat(20000))), item(9, "", "review")];
  const closed = planBodies(shown, new Set());
  assert.equal(closed[0].text, null);
  assert.ok(closed[0].excerpt.length <= 141 && closed[0].excerpt.endsWith("…"));
  const open = planBodies(shown, new Set([0]));
  assert.equal(open[0].text.length, 8000);
  assert.equal(open[0].excerpt, null);
  assert.deepEqual([closed[9].text, closed[9].excerpt], [null, null]);
  assert.deepEqual(planBodies([{ index: 0, entry: { kind: "labeled", author: "a", at: "0", label: "x" } }], new Set()).map((p) => [p.text, p.excerpt]), [[null, null]]);
});

test("reviewInput: the loaded timeline's comments replace the list's last five", () => {
  const pr = { repo: "r/x", number: 1, reviewDecision: null, comments: [{ author: "claude", body: "old", createdAt: "1" }] };
  assert.equal(reviewInput(pr, null), pr);
  const detail = { timeline: [
    { kind: "review", author: "claude", at: "2", body: "CHANGES REQUESTED" },
    { kind: "comment", author: "claude", at: "3", body: "CHANGES REQUESTED: x" },
    { kind: "labeled", author: "n", at: "4", label: "l" },
  ] };
  const r = reviewInput(pr, detail);
  assert.equal(r.reviewDecision, null);
  assert.deepEqual(r.comments, [{ author: "claude", body: "CHANGES REQUESTED: x", createdAt: "3" }]);
  assert.equal(reviewLabel(r, CLAUDE).text, "Changes requested");
});

test("hasOlderActivity: the timeline query returns the last 100, so exactly 100 means there may be more", () => {
  assert.equal(hasOlderActivity({ timeline: new Array(100).fill({}) }), true);
  assert.equal(hasOlderActivity({ timeline: new Array(99).fill({}) }), false);
  assert.equal(hasOlderActivity(null), false);
});

test("the description is capped at the thread budget; truncated()'s own default stays 60 000", () => {
  assert.equal(DESCRIPTION_MAX, THREAD_BUDGET);
  const cut = truncated("d".repeat(DESCRIPTION_MAX + 1), DESCRIPTION_MAX);
  assert.deepEqual([cut.text.length, cut.cut], [DESCRIPTION_MAX, true]);
  assert.equal(truncated("d".repeat(DESCRIPTION_MAX)).cut, false);
  assert.equal(truncated("d".repeat(60001)).cut, true);
});

// What the pane renders: the description, then the thread planned with what is left of the budget.
const rendered = (detail, shown, opened = new Set()) => {
  const desc = truncated(detail.body, DESCRIPTION_MAX).text.trim() ? truncated(detail.body, DESCRIPTION_MAX).text.length : 0;
  const bodies = planBodies(shown, opened, ENTRY_MAX, threadBudgetFor(detail));
  return desc + bodies.reduce((n, p) => n + (p.text?.length ?? 0), 0);
};

test("one render budget: the description is spent first, the thread gets what is left", () => {
  assert.equal(threadBudgetFor({ body: "" }), THREAD_BUDGET);
  assert.equal(threadBudgetFor({ body: "   \n" }), THREAD_BUDGET);
  assert.equal(threadBudgetFor({ body: "d".repeat(20000) }), 4000);
  assert.equal(threadBudgetFor({ body: "d".repeat(50000) }), 0, "the description itself is capped at DESCRIPTION_MAX");
  assert.equal(threadBudgetFor(null), THREAD_BUDGET);
  // 20k description + 20k thread (10 comments of 2k): only 4k of the thread is rendered.
  const detail = { body: "d".repeat(20000) };
  const shown = Array.from({ length: 10 }, (_, i) => item(i, "t".repeat(2000)));
  const plan = planBodies(shown, new Set(), ENTRY_MAX, threadBudgetFor(detail));
  assert.equal(plan.filter((p) => p.text !== null).length, 2);
  assert.ok(rendered(detail, shown) <= THREAD_BUDGET, `rendered ${rendered(detail, shown)}`);
  assert.ok(plan[9].text !== null && plan[0].excerpt !== null, "newest first, older ones as excerpts");
  // A short description leaves the thread its usual room.
  assert.equal(planBodies(shown, new Set(), ENTRY_MAX, threadBudgetFor({ body: "short" })).filter((p) => p.text !== null).length, 10);
  assert.ok(rendered({ body: "d".repeat(24000) }, shown) <= THREAD_BUDGET);
});

test("capDetail keeps bodies at their render caps and remembers the cut", () => {
  const big = { body: "b".repeat(DESCRIPTION_MAX + 500), mergeable: "MERGEABLE", timeline: [
    { kind: "comment", author: "a", at: "1", body: "c".repeat(ENTRY_MAX + 10) },
    { kind: "comment", author: "a", at: "2", body: "short" },
    { kind: "labeled", author: "a", at: "3", label: "x" },
    { kind: "review", author: "a", at: "4", body: "", state: "APPROVED" },
  ] };
  const c = capDetail(big);
  assert.equal(c.body.length, DESCRIPTION_MAX);
  assert.equal(c.bodyCut, true);
  assert.deepEqual(c.timeline.map((e) => [e.body?.length, e.cut]), [[ENTRY_MAX, true], [5, false], [undefined, undefined], [0, false]]);
  assert.equal(c.mergeable, "MERGEABLE");
  assert.equal(big.body.length, DESCRIPTION_MAX + 500, "the input is not changed");
  // Twice is the same as once: the cut is not forgotten when the text is already short.
  const again = capDetail(c);
  assert.equal(again.bodyCut, true);
  assert.equal(again.timeline[0].cut, true);
  assert.equal(capDetail({ body: "ok", timeline: [] }).bodyCut, false);
  assert.equal(capDetail(null), null);
  assert.equal(capDetail({ body: null, timeline: null }).body, "");
  // planBodies reports the remembered cut even though the text now fits.
  const [p] = planBodies([{ index: 0, entry: c.timeline[0] }], new Set());
  assert.equal(p.text.length, ENTRY_MAX);
  assert.equal(p.cut, true);
});

test("the thread keeps a floor: its newest entry renders in full beside a long description", () => {
  assert.equal(THREAD_FLOOR, ENTRY_MAX);
  const thread = [{ kind: "comment", author: "claude", at: "2026-10-31T10:00:00Z", body: "r".repeat(5000) }];
  assert.equal(descriptionCap({ body: "x", timeline: thread }), THREAD_BUDGET - ENTRY_MAX);
  assert.equal(descriptionCap({ body: "x", timeline: [] }), DESCRIPTION_MAX);
  assert.equal(descriptionCap({ body: "x", timeline: [{ kind: "labeled", label: "a" }] }), DESCRIPTION_MAX, "labels alone are no thread");
  const detail = { body: "d".repeat(20000), timeline: thread };
  assert.equal(threadBudgetFor(detail), THREAD_FLOOR);
  const shown = [item(0, "r".repeat(5000))];
  const plan = planBodies(shown, new Set(), ENTRY_MAX, threadBudgetFor(detail));
  assert.equal(plan[0].text?.length, 5000, "the newest review is not an excerpt");
  assert.ok(Math.min(detail.body.length, descriptionCap(detail)) + 5000 <= THREAD_BUDGET);
});

test("scrolledBy: the wheel adds up, never above the top; showsTop past TOP_AFTER", () => {
  assert.equal(scrolledBy(0, { delta: { y: -120 } }), 120, "down");
  assert.equal(scrolledBy(120, { delta: { y: 200 } }), 0, "up past the top stops at 0");
  assert.equal(scrolledBy(0, { delta: { y: 0 }, delta_lines: { y: -3 } }), 60, "lines");
  assert.equal(scrolledBy(50, {}), 50);
  assert.equal(scrolledBy(undefined, { delta: { y: -10 } }), 10);
  assert.equal(showsTop(TOP_AFTER), false);
  assert.equal(showsTop(TOP_AFTER + 1), true);
  assert.equal(showsTop(undefined), false);
});
