import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupOwners, onceUntilFailure } from "../owners.js";
import { prSearch, issueSearch, ownerTerms } from "../queries.js";

// A stand-in for github.js's ghLines: answers by the gh endpoint asked for.
const gh = (answers) => async (args) => {
  const answer = answers[args[1]];
  if (answer instanceof Error) throw answer;
  return answer ?? [];
};

test("lookupOwners: the signed-in user first, then their organizations", async () => {
  const lines = gh({ user: ["sam"], "user/orgs": ["acme", "widgets-inc"] });
  assert.deepEqual(await lookupOwners(lines), ["sam", "acme", "widgets-inc"]);
});

test("lookupOwners: asks gh for the login and for every page of organizations", async () => {
  const asked = [];
  await lookupOwners(async (args) => { asked.push(args); return ["x"]; });
  assert.deepEqual(asked.sort(), [["api", "user", "--jq", ".login"], ["api", "user/orgs", "--paginate", "--jq", ".[].login"]].sort());
});

test("lookupOwners: no organizations is fine, a name that comes twice is listed once", async () => {
  assert.deepEqual(await lookupOwners(gh({ user: ["sam"] })), ["sam"]);
  assert.deepEqual(await lookupOwners(gh({ user: ["sam"], "user/orgs": ["sam", "acme"] })), ["sam", "acme"]);
});

test("lookupOwners: a failure names what could not be looked up", async () => {
  await assert.rejects(lookupOwners(gh({ user: new Error("boom: network is unreachable") })),
    /^Error: Couldn't look up your GitHub login: boom: network is unreachable/);
  await assert.rejects(lookupOwners(gh({ user: ["sam"], "user/orgs": new Error("HTTP 403") })),
    /Couldn't look up your GitHub organizations: HTTP 403\. Set "owners" in config\.json to skip the lookup/);
  await assert.rejects(lookupOwners(gh({})), /didn't say who you are/);
});

test("lookupOwners: signed out, the message says gh auth login, whichever call fails first", async () => {
  const out = new Error("To get started with GitHub CLI, please run:  gh auth login");
  for (const answers of [{ user: out, "user/orgs": out }, { user: out, "user/orgs": ["acme"] }, { user: ["sam"], "user/orgs": out }]) {
    await assert.rejects(lookupOwners(gh(answers)), (e) => /Run gh auth login/.test(e.message) && !/Set "owners"/.test(e.message) && /To get started/.test(e.message));
  }
  // the organizations call failing first (it is the slower one to answer) must not change the verdict
  const slowLogin = async (args) => { if (args[1] === "user") { await new Promise((r) => setImmediate(r)); throw out; } throw new Error("org lookup failed"); };
  await assert.rejects(lookupOwners(slowLogin), /Run gh auth login/);
});

test("onceUntilFailure: the first call runs it, later ones (also while it runs) share the result", async () => {
  let runs = 0;
  const get = onceUntilFailure(async () => { runs++; return ["sam"]; });
  const [a, b] = [get(), get()];
  assert.equal(a, b, "callers that arrive while it runs share one promise");
  assert.deepEqual(await a, ["sam"]);
  assert.deepEqual(await get(), ["sam"]);
  assert.equal(runs, 1);
});

test("onceUntilFailure: a failure is dropped, so the next call tries again", async () => {
  let runs = 0;
  const get = onceUntilFailure(async () => { runs++; if (runs === 1) throw new Error("offline"); return ["sam"]; });
  await assert.rejects(get(), /offline/);
  await new Promise((r) => setImmediate(r)); // the drop happens as the failure settles
  assert.deepEqual(await get(), ["sam"]);
  assert.deepEqual(await get(), ["sam"]);
  assert.equal(runs, 2);
});

test("onceUntilFailure: a failure is shared by the callers that were waiting for it", async () => {
  let runs = 0;
  const get = onceUntilFailure(async () => { runs++; throw new Error("offline"); });
  const results = await Promise.allSettled([get(), get(), get()]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected"]);
  assert.equal(runs, 1);
});

test("the search strings are functions of the owners list", () => {
  assert.equal(ownerTerms(["acme", "sam"]), "owner:acme owner:sam");
  assert.equal(prSearch(["acme", "sam"]), "owner:acme owner:sam is:pr is:open sort:updated-desc");
  assert.equal(issueSearch(["acme", "sam"]), "owner:acme owner:sam is:issue is:open sort:updated-desc");
  assert.equal(prSearch(["acme"]), "owner:acme is:pr is:open sort:updated-desc");
  assert.equal(issueSearch(["sam"]), "owner:sam is:issue is:open sort:updated-desc");
});
