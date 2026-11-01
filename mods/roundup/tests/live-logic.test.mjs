import { test } from "node:test";
import assert from "node:assert/strict";
import { listPollMs, wantsLiveDetail, ciSettled, checkRows, checkMark, LIST_POLL_MS, LIVE_LIST_MS, LIVE_DETAIL_MS } from "../live-logic.js";

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

test("checkRows: empty when everything passed; failed, then running, then the rest, by name", () => {
  assert.deepEqual(checkRows([{ name: "a", state: "success" }, { name: "b", state: "skipped" }]), []);
  assert.deepEqual(checkRows([]), []);
  const rows = checkRows([
    { name: "lint", state: "success" }, { name: "e2e", state: "pending" }, { name: "test", state: "failure" },
    { name: "build", state: "pending" }, { name: "docs", state: "skipped" }, { name: "build", state: "pending" }, { name: "", state: "failure" },
  ]);
  assert.deepEqual(rows.map((r) => `${r.state}:${r.name}`), ["failure:test", "pending:build", "pending:e2e", "success:lint", "skipped:docs"]);
});

test("checkMark", () => {
  assert.equal(checkMark("success"), "✓");
  assert.equal(checkMark("failure"), "✗");
  assert.equal(checkMark("pending"), null);
  assert.equal(checkMark("skipped"), "–");
  assert.equal(checkMark("neutral"), "–");
});
