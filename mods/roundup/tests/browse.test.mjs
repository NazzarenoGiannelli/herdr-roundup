import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../config.js";
import { keyOf, select, viewCounts, stableOrder, chipsFor, ago, shortRepo, priority, errorLine, labelLines, issueRowHeight, parseQuery, search, githubTargets, resultsLine } from "../browse.js";

const pr = (n, o = {}) => ({ repo: "acme/widgets", number: n, isDraft: false, head: "fix/x", base: "staging",
  author: "sam", labels: [], ci: "success", reviewDecision: null, comments: [], ...o });

test("keyOf", () => assert.equal(keyOf(pr(5)), "acme/widgets#5"));

test("select combines the view and the repo (AND); views apply to PRs only", () => {
  const items = [
    pr(1, { isDraft: true }),
    pr(2, { repo: "acme/gadgets", isDraft: true }),
    pr(3, { repo: "acme/gadgets" }),
  ];
  assert.deepEqual(select(items, { tab: "pr", view: "drafts", repo: null }).map((i) => i.number), [1, 2]);
  assert.deepEqual(select(items, { tab: "pr", view: "drafts", repo: "acme/gadgets" }).map((i) => i.number), [2]);
  assert.deepEqual(select(items, { tab: "pr", view: "all", repo: "acme/gadgets" }).map((i) => i.number), [2, 3]);
  assert.deepEqual(select(items, { tab: "issue", view: "drafts", repo: null }).map((i) => i.number), [1, 2, 3]);
});

test("select: a view follows the config's labels", () => {
  const config = normalizeConfig({ labels: { ready: ["ship-it"] } }).config;
  const items = [pr(1, { ci: "failure", labels: ["ship-it"] }), pr(2, { ci: "failure" })];
  assert.deepEqual(select(items, { tab: "pr", view: "ready", repo: null }, config).map((i) => i.number), [1]);
  assert.deepEqual(select(items, { tab: "pr", view: "ready", repo: null }).map((i) => i.number), []);
});

test("viewCounts counts each view within the chosen repo", () => {
  const config = normalizeConfig({ labels: { ready: ["ship-it"] }, reviewers: ["claude"] }).config;
  const items = [
    pr(1, { isDraft: true, labels: ["ship-it"] }),
    pr(2, { author: "dependabot", comments: [{ author: "claude", body: "ok", createdAt: "2026-10-31T10:00:00Z" }] }),
    pr(3, { repo: "acme/gadgets", ci: "pending" }),
  ];
  assert.deepEqual(viewCounts(items, null, config), { all: 3, ready: 2, review: 2, deps: 1, drafts: 1 });
  assert.deepEqual(viewCounts(items, "acme/gadgets", config), { all: 1, ready: 0, review: 1, deps: 0, drafts: 0 });
  assert.deepEqual(viewCounts(items, null, normalizeConfig({ reviewers: ["claude"] }).config), { all: 3, ready: 1, review: 2, deps: 1, drafts: 1 }, "without the label only the dependency bot's PR is ready");
});

test("stableOrder keeps the previous order, drops gone rows, appends new ones in fetch order", () => {
  const fresh = [pr(9), pr(1), pr(2), pr(3)];
  const prev = ["acme/widgets#3", "acme/widgets#7", "acme/widgets#1"];
  assert.deepEqual(stableOrder(fresh, prev).map((i) => i.number), [3, 1, 9, 2]);
  assert.deepEqual(stableOrder(fresh, null).map((i) => i.number), [9, 1, 2, 3]);
});

test("chipsFor shows the top repos, the rest as more, and promotes a chosen one", () => {
  const items = [];
  for (const [repo, n] of [["o/a", 5], ["o/b", 4], ["o/c", 3], ["o/d", 2], ["o/e", 1]]) for (let i = 0; i < n; i++) items.push(pr(items.length + 1, { repo }));
  let r = chipsFor(items, null, 3);
  assert.deepEqual(r.shown.map((c) => c.repo), ["o/a", "o/b", "o/c"]);
  assert.deepEqual(r.more.map((c) => c.repo), ["o/d", "o/e"]);
  r = chipsFor(items, "o/e", 3);
  assert.deepEqual(r.shown.map((c) => c.repo), ["o/a", "o/b", "o/c", "o/e"]);
  assert.deepEqual(r.more.map((c) => c.repo), ["o/d"]);
  r = chipsFor(items, "o/a", 3);
  assert.deepEqual(r.shown.map((c) => c.repo), ["o/a", "o/b", "o/c"]);
});

test("ago", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  assert.equal(ago("2026-10-31T11:59:40Z", now), "now");
  assert.equal(ago("2026-10-31T11:55:00Z", now), "5m");
  assert.equal(ago("2026-10-31T09:00:00Z", now), "3h");
  assert.equal(ago("2026-10-28T12:00:00Z", now), "3d");
  assert.equal(ago("2026-08-01T12:00:00Z", now), "3mo");
  assert.equal(ago("bogus", now), "");
});

test("shortRepo and priority", () => {
  assert.equal(shortRepo("acme/widgets"), "widgets");
  assert.equal(priority(["bug", "priority-high"]), "high");
  assert.equal(priority(["priority-low"]), "low");
  assert.equal(priority(["bug"]), null);
});

test("stableOrder with no previous order re-sorts by updatedAt, newest first (stable on ties)", () => {
  const at = (n, updatedAt) => pr(n, { updatedAt });
  const fresh = [at(1, "2026-10-30T10:00:00Z"), at(2, "2026-10-31T09:00:00Z"), at(3, "2026-10-30T10:00:00Z"), at(4, "2026-10-31T11:00:00Z")];
  assert.deepEqual(stableOrder(fresh, null).map((i) => i.number), [4, 2, 1, 3]);
  // a background poll keeps what was shown, new rows go last, in fetch order
  const shown = ["acme/widgets#1", "acme/widgets#3"];
  assert.deepEqual(stableOrder(fresh, shown).map((i) => i.number), [1, 3, 2, 4]);
  // items without a date keep their fetch order
  assert.deepEqual(stableOrder([pr(7), pr(5), pr(6)], null).map((i) => i.number), [7, 5, 6]);
});

test("errorLine attributes the message to its own list", () => {
  assert.equal(errorLine("pr", null, true), null);
  assert.equal(errorLine("pr", "gh: Bad credentials (HTTP 401)", false), "Couldn't load pull requests: gh: Bad credentials (HTTP 401)");
  assert.equal(errorLine("issue", "API rate limit exceeded", true), "Couldn't load issues: API rate limit exceeded · showing the last list");
});

test("labelLines estimates how many rows the labels wrap into", () => {
  assert.equal(labelLines([], 400), 0);
  assert.equal(labelLines(["bug"], 400), 1);
  const many = ["follow-up", "priority-medium", "needs-human", "auto-fix", "enhancement", "nightly-failure"];
  assert.ok(labelLines(many, 120) > labelLines(many, 600));
  assert.equal(labelLines(["a-very-long-label-name-that-cannot-fit-on-one-line-at-all-here"], 80), 1);
});

test("issueRowHeight grows with the label rows", () => {
  assert.equal(issueRowHeight([], 400), 46);
  assert.ok(issueRowHeight(["bug"], 400) > 46);
  assert.ok(issueRowHeight(["follow-up", "priority-medium", "needs-human", "auto-fix"], 150) > issueRowHeight(["bug"], 150));
});

// --- search -------------------------------------------------------------------------------------

test("parseQuery reads a number, a repo#number, or words", () => {
  assert.deepEqual(parseQuery("130"), { number: 130, repo: null, words: [] });
  assert.deepEqual(parseQuery("#130"), { number: 130, repo: null, words: [] });
  assert.deepEqual(parseQuery("  #130 "), { number: 130, repo: null, words: [] });
  assert.deepEqual(parseQuery("gadgets#130"), { number: 130, repo: "gadgets", words: [] });
  assert.deepEqual(parseQuery("acme/gadgets#130"), { number: 130, repo: "acme/gadgets", words: [] });
  assert.deepEqual(parseQuery("merge staging"), { number: null, repo: null, words: ["merge", "staging"] });
  // `-` splits words, case is folded
  assert.deepEqual(parseQuery("Back-merge"), { number: null, repo: null, words: ["back", "merge"] });
  // typing "gadgets#" already narrows to the repo
  assert.deepEqual(parseQuery("gadgets#"), { number: null, repo: "gadgets", words: [] });
  assert.deepEqual(parseQuery(""), { number: null, repo: null, words: [] });
  assert.deepEqual(parseQuery("   "), { number: null, repo: null, words: [] });
  // a number among words stays a word
  assert.deepEqual(parseQuery("fix 130"), { number: null, repo: null, words: ["fix", "130"] });
});

const at = (n, o = {}) => pr(n, { title: `Title ${n}`, updatedAt: "2026-10-30T10:00:00Z", ...o });
const nums = (items) => items.map((i) => i.number);

test("search: an empty query returns the items unchanged", () => {
  const items = [at(2), at(1)];
  assert.equal(search(items, ""), items);
  assert.equal(search(items, "  "), items);
});

test("search by number: exact first, then numbers starting with the digits, only what matches", () => {
  const items = [at(5), at(139), at(13), at(130), at(1300), at(131), at(7)];
  assert.deepEqual(nums(search(items, "13")), [13, 130, 131, 139, 1300]);
  assert.deepEqual(nums(search(items, "#130")), [130, 1300]);
  assert.deepEqual(nums(search(items, "130")), [130, 1300]);
  assert.deepEqual(nums(search(items, "999")), []);
});

test("search by number: the same number in two repos is ordered by recency, then title mentions come last", () => {
  const items = [
    at(130, { repo: "acme/widgets", updatedAt: "2026-10-01T00:00:00Z" }),
    at(130, { repo: "acme/gadgets", updatedAt: "2026-10-30T00:00:00Z" }),
    at(2, { title: "Follow-up of 130", updatedAt: "2026-10-31T00:00:00Z" }),
    at(1300, { updatedAt: "2026-10-31T00:00:00Z" }),
  ];
  assert.deepEqual(search(items, "130").map(keyOf), [
    "acme/gadgets#130", "acme/widgets#130", "acme/widgets#1300", "acme/widgets#2",
  ]);
});

test("search with repo#number filters by repository, short name or owner/repo, case-insensitive", () => {
  const items = [at(130, { repo: "acme/widgets" }), at(130, { repo: "acme/gadgets" }), at(131, { repo: "sam/gadgets" }), at(5, { repo: "acme/gadgets" })];
  assert.deepEqual(search(items, "gadgets#130").map(keyOf), ["acme/gadgets#130"]);
  assert.deepEqual(search(items, "GADGETS#13").map(keyOf), ["acme/gadgets#130", "sam/gadgets#131"]);
  assert.deepEqual(search(items, "acme/gadgets#130").map(keyOf), ["acme/gadgets#130"]);
  assert.deepEqual(nums(search(items, "acme/gadgets#")), [130, 5]);
  assert.deepEqual(search(items, "widgets#130").map(keyOf), ["acme/widgets#130"]);
});

test("search by words: all words, any order, case-insensitive, `-` splits, title/repo/label", () => {
  const items = [
    at(1, { title: "Back-merge: main → staging", updatedAt: "2026-10-30T00:00:00Z" }),
    at(2, { title: "Merge fix", updatedAt: "2026-10-31T00:00:00Z" }),
    at(3, { title: "Dependabot bump", repo: "acme/gadgets", labels: ["follow-up", "priority-high"] }),
  ];
  assert.deepEqual(nums(search(items, "BACK merge")), [1]);
  assert.deepEqual(nums(search(items, "staging back")), [1]);
  assert.deepEqual(nums(search(items, "Back-merge")), [1]);
  assert.deepEqual(nums(search(items, "merge")), [2, 1]); // newest first
  assert.deepEqual(nums(search(items, "gadgets")), [3]); // repository name
  assert.deepEqual(nums(search(items, "priority-high")), [3]); // a label (its dash splits, both halves match)
  assert.deepEqual(nums(search(items, "follow")), [3]);
  assert.deepEqual(nums(search(items, "merge nothing")), []);
});

test("search tolerates items without labels or dates", () => {
  const items = [{ repo: "o/r", number: 1, title: "alpha" }, { repo: "o/r", number: 2, title: "alpha beta", labels: ["x"] }];
  assert.deepEqual(nums(search(items, "alpha")), [1, 2]);
  assert.deepEqual(nums(search(items, "x")), [2]);
});

test("githubTargets lists the open-on-GitHub URLs of the repositories shown as chips", () => {
  const items = [at(1, { repo: "acme/widgets" }), at(2, { repo: "acme/widgets" }), at(3, { repo: "acme/gadgets" })];
  assert.deepEqual(githubTargets(items, parseQuery("130"), "pr"), [
    { repo: "acme/widgets", url: "https://github.com/acme/widgets/pull/130" },
    { repo: "acme/gadgets", url: "https://github.com/acme/gadgets/pull/130" },
  ]);
  assert.equal(githubTargets(items, parseQuery("#7"), "issue")[1].url, "https://github.com/acme/gadgets/issues/7");
  // a repo in the query narrows the list; owner/repo needs no chip
  assert.deepEqual(githubTargets(items, parseQuery("gadgets#130"), "pr").map((t) => t.repo), ["acme/gadgets"]);
  assert.deepEqual(githubTargets(items, parseQuery("Other/thing#9"), "pr"), [{ repo: "Other/thing", url: "https://github.com/Other/thing/pull/9" }]);
  assert.deepEqual(githubTargets(items, parseQuery("nope#130"), "pr"), []);
  // not a bare number: nothing to open
  assert.deepEqual(githubTargets(items, parseQuery("merge"), "pr"), []);
  assert.deepEqual(githubTargets(items, parseQuery("gadgets#"), "pr"), []);
});

test("resultsLine counts the results", () => {
  assert.equal(resultsLine(0), "0 results · Esc to clear");
  assert.equal(resultsLine(1), "1 result · Esc to clear");
  assert.equal(resultsLine(12), "12 results · Esc to clear");
});

test("search by digits does not match the 3 of a repository name", () => {
  const items = [at(5, { repo: "acme/web3", labels: ["web3"] }), at(7)];
  assert.deepEqual(search(items, "3"), []);
});
