import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarName, retryable, RETRY_MS } from "../avatars-logic.js";
import { PR_LIST, ISSUE_LIST, PR_DETAIL, ISSUE_DETAIL, MERGED_LIST } from "../queries.js";
import { normalizePRs, normalizeDetail } from "../model.js";

test("avatarName: a user's picture, named by id, picture hash and version", () => {
  assert.equal(avatarName("https://avatars.githubusercontent.com/u/13347022?s=64&u=33cb27ca4e190eea4c2839960c689476cc004d1b&v=4"), "u-13347022-33cb27ca-v4.jpg");
});

test("avatarName: an app's picture (claude, dependabot, github-actions)", () => {
  assert.equal(avatarName("https://avatars.githubusercontent.com/in/1236702?s=64&v=4"), "in-1236702-v4.jpg");
});

test("avatarName: anything but GitHub's avatar host over https is refused", () => {
  for (const bad of [null, "", "not a url", "http://avatars.githubusercontent.com/u/1?v=4", "https://example.com/u/1?v=4",
    "https://avatars.githubusercontent.com.evil.com/u/1", "https://avatars.githubusercontent.com/u/../../x", "https://avatars.githubusercontent.com/u/abc"]) {
    assert.equal(avatarName(bad), null, String(bad));
  }
});

test("retryable: a failure waits RETRY_MS; a URL that is not an avatar never comes back", () => {
  assert.equal(retryable(1000, 1000 + RETRY_MS - 1), false);
  assert.equal(retryable(1000, 1000 + RETRY_MS), true);
  assert.equal(retryable(Infinity, Date.now()), false);
});

test("queries: every author brings its avatar, a label's actor does not", () => {
  for (const q of [PR_LIST, ISSUE_LIST, PR_DETAIL, ISSUE_DETAIL, MERGED_LIST]) {
    assert.doesNotMatch(q, /author\{login\}/);
    assert.match(q, /author\{login avatarUrl\(size:64\)\}/);
  }
  assert.match(PR_DETAIL, /actor\{login\}/);
});

test("model: the PR and its comments and reviews carry the avatar URL, null without one", () => {
  const url = "https://avatars.githubusercontent.com/in/1236702?s=64&v=4";
  const [pr] = normalizePRs({ data: { search: { issueCount: 1, nodes: [{
    number: 1, title: "t", url: "u", isDraft: false, updatedAt: "x", headRefName: "h", baseRefName: "b", reviewDecision: null,
    author: { login: "claude", avatarUrl: url }, repository: { nameWithOwner: "o/r" }, labels: { nodes: [] }, commits: { nodes: [] }, comments: { nodes: [] },
  }] } } }).items;
  assert.equal(pr.avatar, url);
  const d = normalizeDetail({ data: { repository: { pullRequest: { timelineItems: { nodes: [
    { __typename: "IssueComment", author: { login: "a", avatarUrl: url }, createdAt: "2026-01-01T00:00:00Z", body: "x" },
    { __typename: "PullRequestReview", author: null, createdAt: "2026-01-02T00:00:00Z", body: "", state: "COMMENTED" },
  ] } } } } });
  assert.deepEqual(d.timeline.map(e => e.avatar), [url, null]);
});
