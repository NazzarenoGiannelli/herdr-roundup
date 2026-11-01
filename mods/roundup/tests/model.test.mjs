import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizePRs, normalizeIssues, normalizeDetail, truncated } from "../model.js";
import { views } from "../rules.js";
import { normalizeConfig } from "../config.js";

const fx = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("normalizePRs: three items and total from issueCount", () => {
  const raw = fx("search-prs.json");
  const { items, total } = normalizePRs(raw);
  assert.equal(items.length, 3);
  assert.equal(total, raw.data.search.issueCount);
});

test("a dependabot PR as GitHub returns it (login without [bot]) is in Dependencies, even with no deps label", () => {
  const { items } = normalizePRs(fx("search-prs.json"));
  const bot = items.find((i) => i.author === "dependabot");
  assert.ok(bot, "the fixture has a dependabot PR");
  const noLabel = normalizeConfig({ labels: { deps: [] } }).config;
  assert.ok(views({ ...bot, labels: [] }, noLabel).includes("deps"));
  assert.ok(!views({ ...items.find((i) => i.author === "sam"), labels: [] }, noLabel).includes("deps"));
});

test("normalizePRs and normalizeIssues carry a partial answer's warning, null otherwise", () => {
  assert.equal(normalizePRs(fx("search-prs.json")).warning, null);
  assert.equal(normalizeIssues(fx("search-issues.json")).warning, null);
  assert.equal(normalizePRs({ ...fx("search-prs.json"), warning: "SSO needed" }).warning, "SSO needed");
  assert.equal(normalizeIssues({ ...fx("search-issues.json"), warning: "SSO needed" }).warning, "SSO needed");
});

test("normalizePRs: maps the PR shape", () => {
  const { items } = normalizePRs(fx("search-prs.json"));
  const pr = items[0];
  assert.equal(pr.repo, "acme/gadgets");
  assert.equal(pr.number, 130);
  assert.equal(typeof pr.title, "string");
  assert.match(pr.url, /^https:\/\/github\.com\//);
  assert.equal(pr.isDraft, false);
  assert.equal(typeof pr.head, "string");
  assert.equal(typeof pr.base, "string");
  assert.equal(typeof pr.author, "string");
  assert.ok(Array.isArray(pr.labels));
  assert.ok(pr.labels.every((l) => typeof l === "string"));
  assert.equal(pr.ci, "success");
  assert.ok(pr.reviewDecision === null || typeof pr.reviewDecision === "string");
  assert.ok(pr.comments.length > 0);
  assert.deepEqual(Object.keys(pr.comments[0]).sort(), ["author", "body", "createdAt"]);
});

test("normalizePRs: one draft, one failing", () => {
  const { items } = normalizePRs(fx("search-prs.json"));
  assert.equal(items.filter((p) => p.isDraft === true).length, 1);
  assert.equal(items.filter((p) => p.ci === "failure").length, 1);
});

test("normalizePRs: total is issueCount even when only 100 nodes arrive", () => {
  const one = fx("search-prs.json").data.search.nodes[0];
  const raw = { data: { search: { issueCount: 140, nodes: Array(100).fill(one) } } };
  const out = normalizePRs(raw);
  assert.equal(out.total, 140);
  assert.equal(out.items.length, 100);
});

test("normalizePRs: tolerates missing rollup, author, comments", () => {
  const raw = {
    data: { search: { issueCount: 1, nodes: [{
      number: 1, title: "t", url: "u", isDraft: false, updatedAt: "2026-01-01T00:00:00Z",
      headRefName: "a", baseRefName: "b", reviewDecision: null, author: null,
      repository: { nameWithOwner: "o/r" },
      labels: { nodes: [] }, commits: { nodes: [] }, comments: { nodes: [{ author: null, createdAt: "x", bodyText: "hi" }] },
    }] } },
  };
  const pr = normalizePRs(raw).items[0];
  assert.equal(pr.ci, "none");
  assert.equal(pr.author, "");
  assert.equal(pr.comments[0].author, "");
});

test("normalizePRs: skips empty nodes (non-PR search hits)", () => {
  const raw = { data: { search: { issueCount: 2, nodes: [{}, null] } } };
  assert.equal(normalizePRs(raw).items.length, 0);
});

test("normalizeIssues: shape and total", () => {
  const raw = fx("search-issues.json");
  const { items, total } = normalizeIssues(raw);
  assert.equal(items.length, 3);
  assert.equal(total, raw.data.search.issueCount);
  const i = items[0];
  assert.deepEqual(Object.keys(i).sort(), ["author", "avatar", "labels", "number", "repo", "title", "updatedAt", "url"]);
  assert.equal(i.repo, "acme/gadgets");
  assert.equal(i.number, 131);
  assert.deepEqual(i.labels, ["enhancement", "priority-medium", "needs-decision"]);
  assert.equal(i.author, "sam");
});

test("normalizeDetail (PR): fields and timeline sorted ascending with a labeled entry", () => {
  const d = normalizeDetail(fx("pr-detail.json"));
  assert.equal(typeof d.body, "string");
  assert.equal(d.mergeable, "MERGEABLE");
  assert.equal(d.mergeState, "CLEAN");
  assert.equal(d.additions, 60);
  assert.equal(d.deletions, 3);
  assert.equal(d.changedFiles, 3);
  const ats = d.timeline.map((t) => t.at);
  assert.deepEqual(ats, [...ats].sort());
  assert.equal(d.timeline.length, 5);
  const labeled = d.timeline.find((t) => t.kind === "labeled");
  assert.ok(labeled);
  assert.equal(typeof labeled.label, "string");
  assert.equal(typeof labeled.author, "string");
  const comment = d.timeline.find((t) => t.kind === "comment");
  assert.equal(typeof comment.body, "string");
});

test("normalizeDetail: review entries carry state and body", () => {
  const raw = {
    data: { repository: { pullRequest: {
      body: "b", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", additions: 1, deletions: 2, changedFiles: 3,
      timelineItems: { nodes: [
        { __typename: "PullRequestReview", author: { login: "claude" }, createdAt: "2026-01-02T00:00:00Z", body: "ok", state: "APPROVED" },
        { __typename: "LabeledEvent", actor: { login: "jonas" }, createdAt: "2026-01-01T00:00:00Z", label: { name: "x" } },
      ] },
    } } },
  };
  const d = normalizeDetail(raw);
  assert.deepEqual(d.timeline[0], { kind: "labeled", author: "jonas", at: "2026-01-01T00:00:00Z", label: "x" });
  assert.deepEqual(d.timeline[1], { kind: "review", author: "claude", avatar: null, at: "2026-01-02T00:00:00Z", body: "ok", state: "APPROVED" });
});

test("normalizeDetail (issue): accepts the issue shape, PR-only fields are null", () => {
  const raw = {
    data: { repository: { issue: {
      body: "hello",
      timelineItems: { nodes: [
        { __typename: "IssueComment", author: { login: "a" }, createdAt: "2026-01-02T00:00:00Z", body: "c" },
        { __typename: "LabeledEvent", actor: null, createdAt: "2026-01-01T00:00:00Z", label: { name: "bug" } },
      ] },
    } } },
  };
  const d = normalizeDetail(raw);
  assert.equal(d.body, "hello");
  for (const k of ["mergeable", "mergeState", "additions", "deletions", "changedFiles"]) assert.equal(d[k], null);
  assert.equal(d.timeline[0].kind, "labeled");
  assert.equal(d.timeline[0].author, "");
  assert.equal(d.timeline[1].kind, "comment");
});

test("normalizeDetail: missing repository yields an empty detail", () => {
  const d = normalizeDetail({ data: { repository: null } });
  assert.equal(d.body, "");
  assert.deepEqual(d.timeline, []);
});

test("truncated: cuts long text at max", () => {
  const out = truncated("x".repeat(70000));
  assert.equal(out.cut, true);
  assert.equal(out.text.length, 60000);
});

test("truncated: leaves short text alone, honours custom max", () => {
  assert.deepEqual(truncated("abc"), { text: "abc", cut: false });
  assert.deepEqual(truncated("abcdef", 3), { text: "abc", cut: true });
  assert.deepEqual(truncated(null), { text: "", cut: false });
});

test("normalizeDetail (PR): checks from the last commit's rollup, one state per check", () => {
  const d = normalizeDetail(fx("pr-detail.json"));
  assert.deepEqual(d.checks, [
    { name: "check", state: "success" },
    { name: "claude-review", state: "success" },
    { name: "deploy", state: "skipped" },
  ]);
  assert.equal(d.additions, 60); // the old fields stay
});

test("normalizeDetail: check conclusions and statuses map to success/pending/failure/skipped/neutral", () => {
  const run = (name, status, conclusion) => ({ __typename: "CheckRun", name, status, conclusion });
  const raw = { data: { repository: { pullRequest: {
    body: "", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 9, nodes: [
      run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "FAILURE"), run("c", "COMPLETED", "TIMED_OUT"),
      run("d", "COMPLETED", "CANCELLED"), run("e", "COMPLETED", "NEUTRAL"), run("f", "COMPLETED", "SKIPPED"),
      run("g", "IN_PROGRESS", null), run("h", "QUEUED", null),
      { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
      { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
      { __typename: "StatusContext", context: "ci/wait", state: "PENDING" },
    ] } } } }] },
  } } } };
  const states = Object.fromEntries(normalizeDetail(raw).checks.map((c) => [c.name, c.state]));
  assert.deepEqual(states, { a: "success", b: "failure", c: "failure", d: "failure", e: "neutral", f: "skipped",
    g: "pending", h: "pending", "ci/legacy": "failure", "ci/ok": "success", "ci/wait": "pending" });
});

test("normalizeDetail: no rollup gives no checks; an issue has none (null)", () => {
  const pr = { data: { repository: { pullRequest: { body: "", commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } } } };
  assert.deepEqual(normalizeDetail(pr).checks, []);
  assert.deepEqual(normalizeDetail({ data: { repository: { pullRequest: { body: "" } } } }).checks, []);
  assert.equal(normalizeDetail({ data: { repository: { issue: { body: "" } } } }).checks, null);
});

test("normalizeDetail (PR): draft state, refs, head commit and CI for the merge button", () => {
  const raw = { data: { repository: { pullRequest: {
    body: "", isDraft: true, headRefName: "fix/x", baseRefName: "staging", headRefOid: "abc123", mergeable: "MERGEABLE", mergeStateStatus: "DRAFT",
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
  } } } };
  const d = normalizeDetail(raw);
  assert.equal(d.isDraft, true);
  assert.equal(d.head, "fix/x");
  assert.equal(d.base, "staging");
  assert.equal(d.headOid, "abc123");
  assert.equal(d.ci, "success");
  assert.equal(normalizeDetail({ data: { repository: { pullRequest: { body: "" } } } }).ci, "none");
});

test("normalizeDetail (issue): the PR-only merge fields are null", () => {
  const d = normalizeDetail({ data: { repository: { issue: { body: "" } } } });
  for (const k of ["isDraft", "head", "base", "headOid", "ci"]) assert.equal(d[k], null);
});
