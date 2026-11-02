import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, groupOpen, pushedLabel, hasOlderCommits, reviewRows, reviewRowLabel } from "../activity-logic.js";
import { normalizeConfig } from "../config.js";

const commit = (oid, at, author = "jonas", o = {}) => ({ oid, short: oid.slice(0, 7), title: `c ${oid}`, at, url: null, author, authorName: author, avatar: null, ci: "success", ...o });
const comment = (at, author = "mira", body = "hi") => ({ kind: "comment", author, avatar: null, at, body });

test("activity: commits woven into the conversation, a run by one author grouped", () => {
  const out = activity(
    [comment("2026-11-01T10:00:00Z"), comment("2026-11-01T12:00:00Z")],
    [commit("a1", "2026-11-01T09:00:00Z"), commit("a2", "2026-11-01T09:30:00Z"), commit("b1", "2026-11-01T11:00:00Z"),
      commit("b2", "2026-11-01T11:10:00Z", "ola"), commit("c1", "2026-11-01T13:00:00Z")]);
  assert.deepEqual(out.map((e) => e.kind === "commits" ? `commits:${e.commits.map((c) => c.oid).join(",")}` : e.kind),
    ["commits:a1,a2", "comment", "commits:b1", "commits:b2", "comment", "commits:c1"]);
  assert.equal(out[0].id, "a1");
  assert.equal(out[0].at, "2026-11-01T09:30:00Z", "a group is as new as its newest commit");
  assert.equal(out[3].author, "ola");
});

test("activity: no commits (an issue) leaves the conversation as it is; bad input is dropped", () => {
  const talk = [comment("2026-11-01T10:00:00Z")];
  assert.deepEqual(activity(talk, null), talk);
  assert.deepEqual(activity(null, [commit("a1", "2026-11-01T09:00:00Z"), { oid: "x" }, null]).length, 1);
  assert.deepEqual(activity(undefined, undefined), []);
});

test("activity: an unlinked author is grouped by name", () => {
  const out = activity([], [commit("a1", "2026-11-01T09:00:00Z", "", { authorName: "Bob" }), commit("a2", "2026-11-01T09:01:00Z", "", { authorName: "bob" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].author, "Bob");
});

test("groupOpen: the newest group and single commits open; a click flips it", () => {
  const two = { id: "a1", commits: [{}, {}] }, one = { id: "b1", commits: [{}] };
  assert.equal(groupOpen(two, true), true);
  assert.equal(groupOpen(two, false), false);
  assert.equal(groupOpen(one, false), true);
  assert.equal(groupOpen(two, false, new Set(["a1"])), true);
  assert.equal(groupOpen(two, true, new Set(["a1"])), false);
  assert.equal(pushedLabel(1), "pushed a commit");
  assert.equal(pushedLabel(4), "pushed 4 commits");
});

test("hasOlderCommits: more on GitHub than fetched", () => {
  assert.equal(hasOlderCommits({ commitCount: 120, commits: new Array(100) }), true);
  assert.equal(hasOlderCommits({ commitCount: 5, commits: new Array(5) }), false);
  assert.equal(hasOlderCommits({ commitCount: null, commits: null }), false);
  assert.equal(hasOlderCommits(null), false);
});

const config = normalizeConfig({ reviewers: ["claude"] }).config;

test("reviewRows: GitHub reviews, a reviewer's comments, requests and running review checks", () => {
  const rows = reviewRows({
    latestReviews: [{ author: "ola", avatar: null, state: "APPROVED", at: "2026-11-01T10:00:00Z" }, { author: "pending", state: "PENDING" }],
    timeline: [comment("2026-11-01T09:00:00Z", "claude", "CHANGES REQUESTED: fix it"), comment("2026-11-01T09:05:00Z", "mira", "nice")],
    reviewRequests: [{ who: "mira", avatar: null, team: false }],
    checks: [{ name: "security-review", state: "pending", startedAt: "2026-11-01T11:00:00Z", url: "https://run/1" }, { name: "test", state: "pending" }, { name: "lint-review", state: "success" }],
  }, config);
  assert.deepEqual(rows.map((r) => `${r.who}:${r.state}`), ["security-review:reviewing", "mira:requested", "claude:changes", "ola:approved"]);
  assert.equal(rows[0].url, "https://run/1");
});

test("reviewRows: a review check named after a reviewer is that reviewer reviewing", () => {
  const rows = reviewRows({
    timeline: [comment("2026-11-01T09:00:00Z", "claude", "Looks good")],
    checks: [{ name: "claude-review", state: "pending", startedAt: "2026-11-01T11:00:00Z", url: "https://run/2" }],
  }, config);
  assert.deepEqual(rows.map((r) => `${r.who}:${r.state}:${r.check}`), ["claude:reviewing:claude-review"]);
});

test("reviewRows: the newer of a GitHub review and a reviewer comment wins", () => {
  const detail = (commentAt) => ({
    latestReviews: [{ author: "claude", state: "CHANGES_REQUESTED", at: "2026-11-01T10:00:00Z" }],
    timeline: [comment(commentAt, "claude", "All fixed, approved")],
  });
  assert.equal(reviewRows(detail("2026-11-01T11:00:00Z"), config)[0].state, "reviewed");
  assert.equal(reviewRows(detail("2026-11-01T09:00:00Z"), config)[0].state, "changes");
});

test("reviewRows: nobody configured, no comment counts; nothing gives no rows", () => {
  assert.deepEqual(reviewRows({ timeline: [comment("2026-11-01T09:00:00Z", "claude", "ok")] }), []);
  assert.deepEqual(reviewRows(null), []);
  assert.deepEqual(reviewRows({}), []);
});

test("reviewRowLabel", () => {
  assert.deepEqual(reviewRowLabel("reviewing"), { text: "reviewing…", tone: "warn" });
  assert.deepEqual(reviewRowLabel("requested"), { text: "waiting for a review", tone: "dim" });
  assert.equal(reviewRowLabel("changes").tone, "bad");
  assert.equal(reviewRowLabel("reviewed").text, "reviewed");
});
