import { test } from "node:test";
import assert from "node:assert/strict";
import { mergedSearch, MERGED_LIST, PR_LIST } from "../queries.js";
import { DEFAULT_MERGED_DAYS } from "../config.js";
import { normalizePRs } from "../model.js";
import { byMerged, errorLine } from "../browse.js";

const node = (extra = {}) => ({
  number: 7, title: "t", url: "u", isDraft: false, updatedAt: "2026-11-01T10:00:00Z",
  headRefName: "fix/x", baseRefName: "staging", reviewDecision: null, author: { login: "a" },
  repository: { nameWithOwner: "acme/widgets" }, labels: { nodes: [] }, commits: { nodes: [] }, comments: { nodes: [] },
  ...extra,
});
const search = (nodes) => ({ data: { search: { issueCount: nodes.length, nodes } } });

test("mergedSearch: merged PRs of the owners since 7 days ago by default (a UTC day)", () => {
  const now = Date.parse("2026-11-01T16:00:00Z");
  assert.equal(DEFAULT_MERGED_DAYS, 7);
  assert.equal(mergedSearch(["acme", "sam"], undefined, now), "owner:acme owner:sam is:pr is:merged merged:>=2026-10-25 sort:updated-desc");
  assert.equal(mergedSearch(["acme"], 7, now), "owner:acme is:pr is:merged merged:>=2026-10-25 sort:updated-desc");
});

test("mergedSearch: the look-back is the configured number of days", () => {
  const now = Date.parse("2026-11-01T16:00:00Z");
  assert.equal(mergedSearch(["acme"], 1, now), "owner:acme is:pr is:merged merged:>=2026-10-31 sort:updated-desc");
  assert.equal(mergedSearch(["acme"], 30, now), "owner:acme is:pr is:merged merged:>=2026-10-02 sort:updated-desc");
});

test("MERGED_LIST: the open-PR list query plus who merged, when and how", () => {
  assert.notEqual(MERGED_LIST, PR_LIST);
  assert.match(MERGED_LIST, /mergedAt mergedBy\{login\} mergeCommit\{parents\{totalCount\}\}/);
  assert.doesNotMatch(MERGED_LIST, /mergeable/, "never in a list query");
});

test("normalizePRs: a merged node says merged, when, by whom and the method from its parents", () => {
  const { items } = normalizePRs(search([
    node({ number: 1, mergedAt: "2026-11-01T16:31:40Z", mergedBy: { login: "priya" }, mergeCommit: { parents: { totalCount: 2 } } }),
    node({ number: 2, mergedAt: "2026-11-01T16:33:30Z", mergedBy: { login: "priya" }, mergeCommit: { parents: { totalCount: 1 } } }),
    node({ number: 3, mergedAt: "2026-11-01T16:00:00Z", mergedBy: null, mergeCommit: null }),
  ]));
  assert.deepEqual(items.map(i => [i.merged, i.method, i.mergedBy]), [[true, "merge", "priya"], [true, "squash", "priya"], [true, null, ""]]);
  assert.equal(items[0].mergedAt, "2026-11-01T16:31:40Z");
});

test("normalizePRs: an open PR has no merged fields at all", () => {
  const [pr] = normalizePRs(search([node()])).items;
  for (const k of ["merged", "mergedAt", "mergedBy", "method"]) assert.equal(k in pr, false, k);
});

test("byMerged: most recently merged first, the input untouched", () => {
  const items = [{ number: 1, mergedAt: "2026-10-30T00:00:00Z" }, { number: 2, mergedAt: "2026-11-01T16:33:30Z" }, { number: 3, mergedAt: "2026-11-01T16:31:40Z" }];
  assert.deepEqual(byMerged(items).map(i => i.number), [2, 3, 1]);
  assert.deepEqual(items.map(i => i.number), [1, 2, 3]);
});

test("errorLine: the Merged view names its own list", () => {
  assert.equal(errorLine("merged", "boom", false), "Couldn't load merged pull requests: boom");
});
