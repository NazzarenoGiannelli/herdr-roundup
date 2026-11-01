import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGraphql, warningLine, methodFromParents, allowedFromRules, isNotFound, isForbidden, isRateLimited, rulesUnavailable } from "../parse.js";

const ok = (stdout, o = {}) => ({ code: 0, stdout, stderr: "", ...o });

test("parseGraphql returns the parsed body on success", () => {
  assert.deepEqual(parseGraphql(ok('{"data":{"search":{"issueCount":1}}}')), { data: { search: { issueCount: 1 } } });
});

test("parseGraphql rejects on a non-zero exit with gh's stderr", () => {
  assert.throws(() => parseGraphql({ code: 1, stdout: "", stderr: "gh: authentication required\n" }), /authentication required/);
  assert.throws(() => parseGraphql({ code: 4, stdout: "", stderr: "" }), /exited with code 4/);
});

test("parseGraphql rejects an HTML body with a readable message", () => {
  assert.throws(() => parseGraphql(ok("<!DOCTYPE html><html><body>Unicorn</body></html>")), /unreadable response/);
  assert.throws(() => parseGraphql(ok("")), /unreadable response/);
});

test("parseGraphql rejects a 200 body with errors, using the first message", () => {
  const body = JSON.stringify({ errors: [{ message: "API rate limit exceeded" }, { message: "second" }], data: null });
  assert.throws(() => parseGraphql(ok(body)), /API rate limit exceeded/);
});

test("parseGraphql keeps a search's results when errors come with them, and says so in body.warning", () => {
  const search = { issueCount: 1, nodes: [{ number: 7 }] };
  const sso = "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.";
  const body = parseGraphql(ok(JSON.stringify({ data: { search }, errors: [{ type: "FORBIDDEN", message: sso }] })));
  assert.deepEqual(body.data.search, search);
  assert.equal(body.warning, sso);
  assert.equal(parseGraphql(ok(JSON.stringify({ data: { search: { issueCount: 0, nodes: [] } }, errors: [{ message: "x" }] }))).warning, "x");
  assert.equal(parseGraphql(ok(JSON.stringify({ data: { search }, errors: [] }))).warning, undefined, "no errors, no warning");
});

test("parseGraphql still fails when the errors come with no usable search results", () => {
  assert.throws(() => parseGraphql(ok(JSON.stringify({ data: null, errors: [{ message: "Bad credentials" }] }))), /Bad credentials/);
  assert.throws(() => parseGraphql(ok(JSON.stringify({ data: { search: null }, errors: [{ message: "boom" }] }))), /boom/);
  assert.throws(() => parseGraphql(ok(JSON.stringify({ data: { search: { issueCount: 3 } }, errors: [{ message: "no nodes" }] }))), /no nodes/);
  assert.throws(() => parseGraphql(ok(JSON.stringify({ data: { repository: { id: 1 } }, errors: [{ message: "detail failed" }] }))), /detail failed/, "only searches are partial");
});

test("warningLine: one line, each message once, at most two named", () => {
  assert.equal(warningLine([{ message: "a" }, { message: "a" }]), "a");
  assert.equal(warningLine([{ message: "a\nmore detail" }, { message: "b" }, { message: "c" }, { message: "d" }]), "a; b (+2 more)");
  assert.equal(warningLine([{}]), "GitHub reported an error for part of this list");
  assert.ok(!warningLine([{ message: "x\ny" }]).includes("\n"));
});

test("parseGraphql rejects when data is missing or null", () => {
  assert.throws(() => parseGraphql(ok('{"data":null}')), /no data/);
  assert.throws(() => parseGraphql(ok("{}")), /no data/);
  assert.throws(() => parseGraphql(ok("[]")), /no data/);
});

test("parseGraphql accepts an empty errors array", () => {
  assert.deepEqual(parseGraphql(ok('{"errors":[],"data":{"a":1}}')).data, { a: 1 });
});

test("methodFromParents: 2 parents merge, 1 squash, none null", () => {
  const n = (c) => [{ mergeCommit: { parents: { totalCount: c } } }];
  assert.equal(methodFromParents(n(2)), "merge");
  assert.equal(methodFromParents(n(1)), "squash");
  assert.equal(methodFromParents([]), null);
  assert.equal(methodFromParents([{ mergeCommit: null }]), null);
  assert.equal(methodFromParents(undefined), null);
});

test("allowedFromRules reads the pull_request rule's allowed_merge_methods", () => {
  const rules = [{ type: "deletion" }, { type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }];
  assert.deepEqual(allowedFromRules(rules), ["merge"]);
  assert.equal(allowedFromRules([{ type: "deletion" }]), null);
  assert.equal(allowedFromRules([{ type: "pull_request", parameters: {} }]), null);
  assert.equal(allowedFromRules([]), null);
  assert.equal(allowedFromRules(null), null);
});

test("isForbidden recognises gh's 403 (and not a 404 or a network error)", () => {
  assert.equal(isForbidden("gh: Resource not accessible by integration (HTTP 403)"), true);
  assert.equal(isForbidden("gh: API rate limit exceeded for user (HTTP 403)"), true);
  assert.equal(isForbidden("gh: Not Found (HTTP 404)"), false);
  assert.equal(isForbidden("error connecting to api.github.com"), false);
  assert.equal(isForbidden("gh: Server Error (HTTP 502)"), false);
});

test("isNotFound recognises gh's 404", () => {
  assert.equal(isNotFound("gh: Not Found (HTTP 404)"), true);
  assert.equal(isNotFound("gh: Branch not found (HTTP 404)"), true);
  assert.equal(isNotFound("error connecting to api.github.com"), false);
});

test("a 404 is only the exact gh status: other messages that say 'not found' or contain 404 are failures", () => {
  assert.equal(isNotFound("gh: Not Found"), false);
  assert.equal(isNotFound("lookup api.github.com: no such host (not found)"), false);
  assert.equal(isNotFound("<html>404 page</html>"), false);
  assert.equal(isNotFound("gh: Not Found (HTTP 4040)"), false);
  assert.equal(isForbidden("gh: Forbidden"), false);
  assert.equal(isForbidden("error 403 from proxy"), false);
});

test("rulesUnavailable: a 404 or a 403 degrades the rules lookup, a rate limit never does", () => {
  assert.equal(rulesUnavailable("gh: Not Found (HTTP 404)"), true);
  assert.equal(rulesUnavailable("gh: Resource not accessible by integration (HTTP 403)"), true);
  assert.equal(rulesUnavailable("gh: API rate limit exceeded for user ID 1. (HTTP 403)"), false);
  assert.equal(rulesUnavailable("gh: You have exceeded a secondary rate limit (HTTP 403)"), false);
  assert.equal(rulesUnavailable("gh: Too Many Requests (HTTP 429)"), false);
  assert.equal(rulesUnavailable("gh: Server Error (HTTP 502)"), false);
  assert.equal(rulesUnavailable("error connecting to api.github.com"), false);
  assert.equal(isRateLimited("API rate limit exceeded"), true);
  assert.equal(isRateLimited("gh: Forbidden (HTTP 403)"), false);
});

test("allowedFromRules: several pull_request rules all apply, so the result is their intersection", () => {
  const pull = (m) => ({ type: "pull_request", parameters: { allowed_merge_methods: m } });
  assert.deepEqual(allowedFromRules([pull(["merge", "squash"]), { type: "deletion" }, pull(["merge", "rebase"])]), ["merge"]);
  assert.deepEqual(allowedFromRules([pull(["squash", "merge", "rebase"]), pull(["rebase", "squash"])]), ["squash", "rebase"]);
  assert.deepEqual(allowedFromRules([pull(["squash"]), pull(["merge"])]), []);
  // A rule that restricts nothing is no restriction; only the rules that list methods count.
  assert.deepEqual(allowedFromRules([{ type: "pull_request", parameters: {} }, pull(["merge"])]), ["merge"]);
  assert.equal(allowedFromRules([{ type: "pull_request", parameters: {} }, { type: "pull_request" }]), null);
});

test("a 403 for abuse detection or with retry-after is a rate limit, not 'no rules'", () => {
  assert.equal(isRateLimited("gh: You have triggered an abuse detection mechanism (HTTP 403)"), true);
  assert.equal(rulesUnavailable("gh: You have triggered an abuse detection mechanism (HTTP 403)"), false);
  assert.equal(rulesUnavailable("gh: Retry-After: 60 (HTTP 403)"), false);
  assert.equal(rulesUnavailable("gh: Resource not accessible by integration (HTTP 403)"), true);
});
