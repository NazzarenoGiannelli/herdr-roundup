import { test } from "node:test";
import assert from "node:assert/strict";
import { listPollMs, wantsLiveDetail, ciSettled, checkRows, checkMark, checksOpen, checksSummary, checkTime, duration, LIST_POLL_MS, LIVE_LIST_MS, LIVE_DETAIL_MS } from "../live-logic.js";

test("listPollMs: faster only while an open pull request has CI running", () => {
  assert.equal(listPollMs([{ ci: "success" }, { ci: "failure" }]), LIST_POLL_MS);
  assert.equal(listPollMs([{ ci: "success" }, { ci: "pending" }]), LIVE_LIST_MS);
  assert.equal(listPollMs([{ ci: "pending", merged: true }]), LIST_POLL_MS, "a merged one is not followed");
  assert.equal(listPollMs(null), LIST_POLL_MS);
  assert.ok(LIVE_LIST_MS < LIST_POLL_MS);
});

test("wantsLiveDetail: a loaded detail with a running check, read at least LIVE_DETAIL_MS ago", () => {
  const now = 1_000_000;
  const entry = (o = {}) => ({ loading: false, at: now - LIVE_DETAIL_MS, detail: { checks: [{ name: "test", state: "pending" }, { name: "lint", state: "success" }] }, ...o });
  assert.equal(wantsLiveDetail(entry(), now), true);
  assert.equal(wantsLiveDetail(entry({ at: now - 1000 }), now), false, "read a second ago");
  assert.equal(wantsLiveDetail(entry({ loading: true }), now), false);
  assert.equal(wantsLiveDetail(entry({ detail: { checks: [{ name: "test", state: "success" }] } }), now), false, "nothing running");
  assert.equal(wantsLiveDetail(entry({ detail: { checks: null } }), now), false, "an issue");
  assert.equal(wantsLiveDetail(entry({ detail: null }), now), false);
  assert.equal(wantsLiveDetail(null, now), false);
  assert.equal(wantsLiveDetail(entry({ at: undefined }), now), true, "never stamped: read it");
});

test("ciSettled: running before, finished now", () => {
  assert.equal(ciSettled("pending", "success"), true);
  assert.equal(ciSettled("pending", "failure"), true);
  assert.equal(ciSettled("pending", "pending"), false);
  assert.equal(ciSettled("success", "failure"), false);
  assert.equal(ciSettled("pending", null), false);
});

test("checkRows: every check, failed, then running, then queued, then the rest, by name", () => {
  assert.deepEqual(checkRows([{ name: "b", state: "skipped" }, { name: "a", state: "success" }]).map((r) => r.name), ["a", "b"], "all green: still listed");
  assert.deepEqual(checkRows([]), []);
  assert.deepEqual(checkRows([{ name: "z", state: "pending", phase: "queued" }, { name: "y", state: "pending", phase: "running" }]).map((r) => `${r.name}:${r.phase}`),
    ["y:running", "z:queued"], "running before queued");
  assert.deepEqual(checkRows([{ name: "t", state: "pending" }])[0], { name: "t", state: "pending", phase: "running", startedAt: null, completedAt: null, url: null }, "no phase: running");
  const rows = checkRows([
    { name: "lint", state: "success" }, { name: "e2e", state: "pending" }, { name: "test", state: "failure" },
    { name: "build", state: "pending" }, { name: "docs", state: "skipped" }, { name: "build", state: "pending" }, { name: "", state: "failure" },
  ]);
  assert.deepEqual(rows.map((r) => `${r.state}:${r.name}`), ["failure:test", "pending:build", "pending:e2e", "success:lint", "skipped:docs"]);
});

test("checksOpen: open while something runs or failed, one line when all passed; a click flips it", () => {
  const green = checkRows([{ name: "a", state: "success" }]), red = checkRows([{ name: "a", state: "failure" }]), busy = checkRows([{ name: "a", state: "pending" }]);
  assert.equal(checksOpen(green), false);
  assert.equal(checksOpen(green, true), true);
  assert.equal(checksOpen(red), true);
  assert.equal(checksOpen(busy), true);
  assert.equal(checksOpen(busy, true), false);
});

test("checksSummary: only the parts that are there", () => {
  const rows = checkRows([
    { name: "a", state: "success" }, { name: "b", state: "success" }, { name: "c", state: "skipped" }, { name: "d", state: "neutral" },
    { name: "e", state: "failure" }, { name: "f", state: "pending", phase: "queued" }, { name: "g", state: "pending", phase: "running" },
  ]);
  assert.equal(checksSummary(rows), "1 failed · 1 running · 1 queued · 2 passed · 2 skipped");
  assert.equal(checksSummary(checkRows([{ name: "a", state: "success" }])), "1 passed");
  assert.equal(checksSummary([]), "");
});

test("checkTime: queued, running for how long, how long a finished one took", () => {
  const now = Date.parse("2026-11-02T10:01:05Z");
  assert.equal(checkTime({ state: "pending", phase: "queued" }, now), "queued");
  assert.equal(checkTime({ state: "pending", phase: "running", startedAt: "2026-11-02T10:00:00Z" }, now), "running 1m 5s");
  assert.equal(checkTime({ state: "pending", phase: "running", startedAt: null }, now), "");
  assert.equal(checkTime({ state: "success", startedAt: "2026-11-02T10:00:00Z", completedAt: "2026-11-02T10:00:49Z" }, now), "49s");
  assert.equal(checkTime({ state: "failure", startedAt: "2026-11-02T10:00:00Z", completedAt: null }, now), "");
  assert.equal(checkTime({ state: "skipped", startedAt: "2026-11-02T10:00:00Z", completedAt: "2026-11-02T10:00:00Z" }, now), "", "a skipped one took no time worth saying");
  assert.equal(duration(85_000), "1m 25s");
  assert.equal(duration(7_380_000), "2h 3m");
});

test("checkMark", () => {
  assert.equal(checkMark("pending", "queued"), "○");
  assert.equal(checkMark("success"), "✓");
  assert.equal(checkMark("failure"), "✗");
  assert.equal(checkMark("pending"), null);
  assert.equal(checkMark("skipped"), "–");
  assert.equal(checkMark("neutral"), "–");
});
