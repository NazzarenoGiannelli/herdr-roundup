// Everything the panel reads from GitHub, through `gh`: queries and GETs, plus the three writes
// (merge, update branch, comment) at the bottom, whose arguments are built by actions-logic.js.
// Each function rejects with a readable Error: gh's stderr, or GraphQL's first error message.
import { exec, shared, setShared } from "herdr";
import { mergePlan, commentArgs, runPlan, commentProblem } from "./actions-logic.js";
import { normalizePRs, normalizeIssues, normalizeDetail } from "./model.js";
import { behindFromCompare, comparePath, updateArgs } from "./update-logic.js";
import { parseGraphql, methodFromParents, allowedFromRules, isNotFound, rulesUnavailable } from "./parse.js";
import { lookupOwners, onceUntilFailure } from "./owners.js";
import { PR_LIST, ISSUE_LIST, PR_DETAIL, ISSUE_DETAIL, LAST_MERGED, MERGED_LIST, prSearch, issueSearch, mergedSearch } from "./queries.js";

const graphql = async (query, vars) =>
  parseGraphql(await exec("gh", ["api", "graphql", "-f", "query=" + query, ...Object.entries(vars).flatMap(([k, v]) =>
    typeof v === "number" ? ["-F", `${k}=${v}`] : ["-f", `${k}=${v}`])]));

// --- whose pull requests and issues -------------------------------------------------------------

// Plain-text output of a gh call, or a readable Error: gh's stderr.
async function ghLines(args) {
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || `gh exited with code ${r.code}`);
  return String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const defaultOwners = onceUntilFailure(() => lookupOwners(ghLines)); // for the app's run; a failure is not kept

// config.owners when the person listed some, else the signed-in user and their organizations (looked up once).
export const resolveOwners = (config) => config.owners ? Promise.resolve(config.owners) : defaultOwners();

export const fetchPRs = async (config) => normalizePRs(await graphql(PR_LIST, { q: prSearch(await resolveOwners(config)) }));
export const fetchIssues = async (config) => normalizeIssues(await graphql(ISSUE_LIST, { q: issueSearch(await resolveOwners(config)) }));
export const fetchMerged = async (config) => normalizePRs(await graphql(MERGED_LIST, { q: mergedSearch(await resolveOwners(config), config.mergedDays) }));

// kind: "pr" (default) or "issue".
export async function fetchDetail(repo, number, kind = "pr") {
  const [owner, name] = repo.split("/");
  return normalizeDetail(await graphql(kind === "issue" ? ISSUE_DETAIL : PR_DETAIL, { owner, name, number: Number(number) }));
}

// A REST GET: parsed JSON, or null for "(HTTP 404)" (the thing does not exist); with `soft`, also for
// a 403 that is not a rate limit (see parse.rulesUnavailable). Anything else rejects.
async function get(path, { soft = false } = {}) {
  const r = await exec("gh", ["api", path]);
  if (r.code !== 0) {
    if (soft ? rulesUnavailable(r.stderr) : isNotFound(r.stderr)) return null;
    throw new Error((r.stderr || "").trim() || `gh exited with code ${r.code}`);
  }
  try { return JSON.parse(r.stdout); } catch { throw new Error("GitHub returned an unreadable response (not JSON)"); }
}

// How far a pull request's branch is behind its base, and when its head commit was made.
export async function fetchBehind(repo, headOid, base) {
  const json = await get(comparePath(repo, headOid, base));
  if (!json) throw new Error(`Couldn't compare the branch with ${base}`);
  return behindFromCompare(json);
}

const repoCache = new Map(); // "repo:base" -> Promise, for the app's run; a failure is not kept

async function loadRepo(repo, base, config) {
  const [owner, name] = repo.split("/");
  const branch = base.split("/").map(encodeURIComponent).join("/");
  const [info, staging, rules] = await Promise.all([
    get(`repos/${repo}`),
    // Only the staging flow looks at a `staging` branch: "(HTTP 404)" only means there is none; anything else rejects.
    config.stagingFlow ? get(`repos/${repo}/branches/staging`) : Promise.resolve(null),
    // Branch rules are an extra: only "(HTTP 404)" or "(HTTP 403)" that is not a rate limit (no rules /
    // no access) degrades to settings alone (allowedByRules null; GitHub still refuses a method the
    // rules forbid). Any other error, a rate limit included, rejects the lookup: the bar shows it, the
    // next detail load (or the refresh button) retries, and a failure is not cached.
    get(`repos/${repo}/rules/branches/${branch}`, { soft: true }),
  ]);
  if (!info) throw new Error(`Repository ${repo} not found`);
  const hasStaging = staging !== null;
  // The default comes from history (the last merged PR into this base) unless the staging flow already
  // decides it, which it does for a repository that has a `staging` branch.
  const lastMethod = config.stagingFlow && hasStaging ? null
    : methodFromParents((await graphql(LAST_MERGED, { owner, name, base }))?.data?.repository?.pullRequests?.nodes);
  return {
    settings: { squash: !!info.allow_squash_merge, merge: !!info.allow_merge_commit, rebase: !!info.allow_rebase_merge },
    hasStaging,
    lastMethod,
    allowedByRules: allowedFromRules(rules),
  };
}

export function fetchRepo(repo, base, config) {
  const key = `${repo}:${base}`;
  if (!repoCache.has(key)) {
    const p = loadRepo(repo, base, config);
    repoCache.set(key, p);
    p.catch(() => repoCache.delete(key));
  }
  return repoCache.get(key);
}

// --- writes ------------------------------------------------------------------------------------
// With the shared key "roundup.dryRun" set to true nothing is executed: each command that would
// have run is appended to the shared list "roundup.dryLog" (the last 50). For checking the UI.

export const isDryRun = () => shared("roundup.dryRun") === true;
const dryLog = (line) => {
  const old = shared("roundup.dryLog");
  setShared("roundup.dryLog", [...(Array.isArray(old) ? old : []), line].slice(-50));
};
const write = (plan) => runPlan(plan, { exec, dry: isDryRun(), log: dryLog });

// Merges a PR. `draft`: marks it ready first. `headOid`: refused by GitHub if the branch moved.
export const merge = (repo, number, method, { draft = false, headOid = null } = {}) =>
  write(mergePlan(repo, number, method, { draft, headOid }));

// Merges the base into the PR's branch (GitHub's "Update branch"). Refused if the branch moved since `headOid`.
export const updateBranch = (repo, number, headOid) => write([{ step: "update", args: updateArgs(repo, number, headOid) }]);

// Comments on a PR (kind "pr") or an issue (kind "issue").
export const comment = (kind, repo, number, body) => {
  const problem = commentProblem(body);
  if (problem) return Promise.reject(new Error(problem)); // too long for gh's command line: never sent
  return write([{ step: "comment", args: commentArgs(kind, repo, number, body) }]);
};
