import { test } from "node:test";
import assert from "node:assert/strict";
import { behindFromCompare, behindKey, comparePath, updateArgs, NO_HEAD_UPDATE, wantsBehind, dayLabel, behindLine, updateView } from "../update-logic.js";

const item = (o = {}) => ({ repo: "acme/widgets", number: 130, isDraft: false, head: "fix/x", base: "staging", author: "alice", ...o });
const detail = (o = {}) => ({ mergeable: "MERGEABLE", isDraft: false, headOid: "aaa", head: "fix/x", base: "staging", ...o });
const NOW = Date.parse("2026-11-02T10:00:00Z");

test("behindFromCompare: ahead_by of head...base is how far the branch is behind; base_commit is the head commit", () => {
  const json = { ahead_by: 15, behind_by: 2, base_commit: { commit: { committer: { date: "2026-10-23T15:56:01Z" }, author: { date: "2026-10-22T00:00:00Z" } } } };
  assert.deepEqual(behindFromCompare(json), { count: 15, lastCommitAt: "2026-10-23T15:56:01Z" });
  assert.deepEqual(behindFromCompare({ ahead_by: 0 }), { count: 0, lastCommitAt: null });
  assert.equal(behindFromCompare({ ahead_by: 3, base_commit: { commit: { author: { date: "2026-10-01T00:00:00Z" } } } }).lastCommitAt, "2026-10-01T00:00:00Z");
});

test("behindFromCompare: anything without a count is an error, never a silent 0", () => {
  for (const bad of [null, {}, { ahead_by: "x" }, { ahead_by: -1 }, { ahead_by: 1.5 }]) assert.throws(() => behindFromCompare(bad), /unreadable comparison/);
});

test("comparePath and behindKey", () => {
  assert.equal(comparePath("acme/w", "abc", "staging"), "repos/acme/w/compare/abc...staging");
  assert.equal(comparePath("acme/w", "abc", "release/1.2"), "repos/acme/w/compare/abc...release/1.2");
  assert.equal(comparePath("acme/w", "abc", "a b"), "repos/acme/w/compare/abc...a%20b");
  assert.notEqual(behindKey("acme/w#1", "abc", "staging"), behindKey("acme/w#1", "abd", "staging"));
  assert.notEqual(behindKey("acme/w#1", "abc", "staging"), behindKey("acme/w#1", "abc", "main"));
});

test("updateArgs: a PUT on update-branch that pins the head commit, never a rebase", () => {
  const a = updateArgs("acme/widgets", 130, "abc123");
  assert.deepEqual(a, ["api", "-X", "PUT", "repos/acme/widgets/pulls/130/update-branch", "-f", "expected_head_sha=abc123"]);
  assert.ok(!a.join(" ").includes("rebase"));
  assert.throws(() => updateArgs("acme/widgets", 130, null), (e) => e.message === NO_HEAD_UPDATE);
  assert.throws(() => updateArgs("acme/widgets", 130, ""), (e) => e.message === NO_HEAD_UPDATE);
});

test("wantsBehind: open, non-draft, loaded, not a dependency bot", () => {
  assert.equal(wantsBehind(item(), detail()), true);
  assert.equal(wantsBehind(item(), null), false, "detail not loaded");
  assert.equal(wantsBehind(item({ merged: true }), detail()), false);
  assert.equal(wantsBehind(item(), detail({ isDraft: true })), false);
  assert.equal(wantsBehind(item({ isDraft: true }), detail({ isDraft: null })), false, "the list's draft flag until the detail says");
  assert.equal(wantsBehind(item(), detail({ headOid: null })), false);
  for (const bot of ["dependabot", "dependabot[bot]", "app/renovate"]) assert.equal(wantsBehind(item({ author: bot }), detail()), false, bot);
});

test("dayLabel: month and day, the year only when it is not this one", () => {
  assert.equal(dayLabel("2026-10-23T15:56:01Z", NOW), "Oct 23");
  assert.equal(dayLabel("2025-12-30T12:00:00Z", NOW), "Dec 30, 2025");
  assert.equal(dayLabel("nope", NOW), "");
});

test("behindLine: count, base and last commit; null when up to date or unknown", () => {
  assert.equal(behindLine({ count: 15, lastCommitAt: "2026-10-23T15:56:01Z" }, "staging", NOW), "15 commits behind staging · last commit Oct 23");
  assert.equal(behindLine({ count: 1, lastCommitAt: null }, "main", NOW), "1 commit behind main");
  assert.equal(behindLine({ count: 0, lastCommitAt: "2026-10-23T15:56:01Z" }, "staging", NOW), null);
  assert.equal(behindLine(null, "staging", NOW), null);
});

test("updateView: shown only when the branch is behind and has no conflicts", () => {
  const behind = { count: 4 };
  assert.deepEqual(updateView({ item: item(), detail: detail(), behind }), { enabled: true, armed: false, label: "⇣ Update branch", note: null });
  assert.equal(updateView({ item: item(), detail: detail(), behind: { count: 0 } }), null);
  assert.equal(updateView({ item: item(), detail: detail(), behind: null }), null, "not compared yet");
  assert.equal(updateView({ item: item(), detail: detail({ mergeable: "CONFLICTING" }), behind }), null);
  assert.equal(updateView({ item: item(), detail: detail({ isDraft: true }), behind }), null);
  assert.equal(updateView({ item: item({ author: "dependabot" }), detail: detail(), behind }), null);
});

test("updateView: two clicks; the armed state holds only for the head commit it was armed on", () => {
  const behind = { count: 4 };
  const armed = updateView({ item: item(), detail: detail(), behind, armed: { headOid: "aaa" } });
  assert.equal(armed.armed, true);
  assert.equal(armed.label, "Confirm update");
  assert.equal(armed.note, "Click again to merge staging into fix/x · Esc to cancel");
  assert.equal(updateView({ item: item(), detail: detail({ headOid: "bbb" }), behind, armed: { headOid: "aaa" } }).armed, false, "a new push needs a new click");
});

test("updateView: running, or another write in progress", () => {
  const behind = { count: 4 };
  assert.deepEqual(updateView({ item: item(), detail: detail(), behind, updating: true }), { enabled: false, armed: false, label: "Updating…", note: "Updating the branch…" });
  const busy = updateView({ item: item(), detail: detail(), behind, armed: { headOid: "aaa" }, busy: true });
  assert.equal(busy.enabled, false);
  assert.equal(busy.armed, false);
});
