// Pure parsing of `gh` results, used by github.js. No imports: loaded by Node
// tests and by the Herdr runtime alike.

// `gh api graphql` can exit 0 with `{ "errors": [...], "data": null }`, or print
// an HTML error page. Any of those must reach the panel as a readable Error,
// never as an empty list that reads as "nothing open".
//
// One exception: a search that answers with results *and* errors (an organization that needs SSO
// authorization for the token, for example, fails for that owner only). The results are kept and
// `body.warning` carries the errors as one line, so the list shows what it has and says what is missing.
export function parseGraphql(result) {
  if (result.code !== 0) {
    const text = (result.stderr || "").trim() || (result.stdout || "").trim().split("\n")[0];
    throw new Error(text || `gh exited with code ${result.code}`);
  }
  let body;
  try { body = JSON.parse(result.stdout); }
  catch { throw new Error("GitHub returned an unreadable response (not JSON)"); }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const usable = Array.isArray(body?.data?.search?.nodes);
  if (errors.length > 0 && !usable) throw new Error(String(errors[0]?.message || "GitHub reported an error"));
  if (!body || typeof body !== "object" || body.data == null) throw new Error("GitHub returned no data");
  if (errors.length > 0) body.warning = warningLine(errors);
  return body;
}

// The errors of a partial answer as one line: each distinct message once (first line only), at most
// two, then the count of the rest. Which owner failed is whatever GitHub's message says.
export function warningLine(errors) {
  const messages = [...new Set((Array.isArray(errors) ? errors : [])
    .map((e) => String(e?.message || "").trim().split("\n")[0].replace(/\s+/g, " "))
    .filter(Boolean))];
  if (messages.length === 0) return "GitHub reported an error for part of this list";
  const shown = messages.slice(0, 2).join("; ");
  return messages.length > 2 ? `${shown} (+${messages.length - 2} more)` : shown;
}

// The merge commit of the most recently merged PR: 2 parents is a merge commit,
// 1 is a squash (a rebase looks the same and is not told apart), none is unknown.
export function methodFromParents(nodes) {
  const count = nodes?.[0]?.mergeCommit?.parents?.totalCount;
  return count === 2 ? "merge" : count === 1 ? "squash" : null;
}

// The merge methods the branch rules allow, from GET repos/{repo}/rules/branches/{base}, or null
// when no rule restricts them. Several `pull_request` rules (one per ruleset) all apply: a method
// must be allowed by each of them, so the result is the intersection.
export function allowedFromRules(rules) {
  const lists = (Array.isArray(rules) ? rules : [])
    .filter((r) => r?.type === "pull_request")
    .map((r) => r.parameters?.allowed_merge_methods)
    .filter(Array.isArray);
  return lists.length === 0 ? null : lists.reduce((a, b) => a.filter((m) => b.includes(m)));
}

// gh prints "... (HTTP 404)" for an API error. Only that exact status counts: a message that merely
// says "not found" (a network failure, a proxy page) is a failure to report, not an answer.
export const isNotFound = (stderr) => /\(HTTP 404\)/.test(String(stderr || ""));
export const isForbidden = (stderr) => /\(HTTP 403\)/.test(String(stderr || ""));
export const isRateLimited = (stderr) => /rate limit|abuse detection|retry-after/i.test(String(stderr || ""));
// The branch-rules endpoint is an extra: "no access" (403) or "no rules" (404) is a normal answer, but
// a rate limit (also a 403) is a failure to surface, and is not remembered.
export const rulesUnavailable = (stderr) => !isRateLimited(stderr) && (isNotFound(stderr) || isForbidden(stderr));
