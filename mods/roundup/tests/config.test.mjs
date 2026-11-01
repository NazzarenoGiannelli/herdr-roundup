import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, DEFAULT_MERGED_DAYS, normalizeConfig, parseConfig, configNote, hasLabel, isReviewer } from "../config.js";

const clean = (raw) => normalizeConfig(raw);

test("defaults: no owners (looked up), no staging flow, only the dependencies label, nobody is the reviewer, 7 days", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    owners: null, stagingFlow: false, labels: { ready: [], review: [], deps: ["dependencies"] }, reviewers: [], mergedDays: 7,
  });
  assert.equal(DEFAULT_MERGED_DAYS, 7);
  assert.deepEqual(clean({}), { config: DEFAULT_CONFIG, problems: [] });
});

test("normalizeConfig: a complete valid config is taken as it is", () => {
  const raw = {
    owners: ["acme", "sam"], stagingFlow: true,
    labels: { ready: ["ship-it"], review: ["needs-eyes"], deps: ["chore"] }, reviewers: ["priya", "claude"], mergedDays: 14,
  };
  assert.deepEqual(clean(raw), { config: raw, problems: [] });
});

test("normalizeConfig: a field that is missing keeps its default, also inside labels", () => {
  const { config, problems } = clean({ labels: { ready: ["ship-it"] } });
  assert.deepEqual(config.labels, { ready: ["ship-it"], review: [], deps: ["dependencies"] });
  assert.deepEqual(problems, []);
  assert.equal(clean({ stagingFlow: true }).config.mergedDays, 7);
});

test("normalizeConfig: lists are trimmed and lose their repeats", () => {
  const { config } = clean({ owners: [" acme ", "acme", "sam"], reviewers: ["claude", "claude "] });
  assert.deepEqual(config.owners, ["acme", "sam"]);
  assert.deepEqual(config.reviewers, ["claude"]);
});

test("normalizeConfig: an empty owners list means look them up; an empty reviewers or labels list is kept", () => {
  assert.deepEqual(clean({ owners: [] }), { config: DEFAULT_CONFIG, problems: [] });
  assert.deepEqual(clean({ reviewers: [] }).config.reviewers, []);
  assert.deepEqual(clean({ labels: { deps: [] } }).config.labels.deps, []);
});

test("normalizeConfig: an invalid field is named, and only that field falls back to its default", () => {
  const bad = (raw, text) => {
    const { config, problems } = clean({ mergedDays: 3, ...raw });
    assert.equal(problems.length, 1, JSON.stringify(raw));
    assert.match(problems[0], text);
    assert.equal(config.mergedDays, 3, "the valid fields are kept");
    return config;
  };
  assert.equal(bad({ owners: "acme" }, /"owners" must be a list/).owners, null);
  assert.equal(bad({ owners: ["acme", 3] }, /"owners" must be a list/).owners, null);
  assert.equal(bad({ owners: [""] }, /"owners" must be a list/).owners, null);
  assert.equal(bad({ owners: ["acme corp"] }, /not a GitHub login: acme corp/).owners, null);
  assert.equal(bad({ owners: ["acme", "org:evil"] }, /not a GitHub login: org:evil/).owners, null);
  assert.equal(bad({ stagingFlow: "yes" }, /"stagingFlow" must be true or false/).stagingFlow, false);
  assert.deepEqual(bad({ labels: ["ready"] }, /"labels" must be an object/).labels, DEFAULT_CONFIG.labels);
  assert.deepEqual(bad({ labels: { ready: "ship-it" } }, /"labels.ready" must be a list/).labels, DEFAULT_CONFIG.labels);
  assert.deepEqual(bad({ reviewers: "claude" }, /"reviewers" must be a list/).reviewers, []);
});

test("normalizeConfig: mergedDays is a whole number of days, 1 to 365", () => {
  for (const ok of [1, 7, 30, 365]) assert.deepEqual(clean({ mergedDays: ok }), { config: { ...DEFAULT_CONFIG, mergedDays: ok }, problems: [] });
  for (const bad of [0, -1, 366, 2.5, "7", null, NaN]) {
    const { config, problems } = clean({ mergedDays: bad });
    assert.equal(config.mergedDays, 7, String(bad));
    assert.match(problems[0], /"mergedDays" must be a whole number from 1 to 365/);
  }
});

test("normalizeConfig: an unknown field is reported (a typo does nothing otherwise), notes starting with _ or $ are not", () => {
  const { config, problems } = clean({ owner: ["acme"], labels: { ready: ["a"], urgent: ["b"] }, _note: "mine", $schema: "x" });
  assert.deepEqual(problems, ['unknown field "owner"', 'unknown field "labels.urgent"']);
  assert.equal(config.owners, null);
  assert.deepEqual(config.labels.ready, ["a"]);
});

test("normalizeConfig: anything that is not an object is a problem, with the defaults", () => {
  for (const raw of [null, [], "text", 7, true, undefined]) {
    assert.deepEqual(clean(raw), { config: DEFAULT_CONFIG, problems: ["the file must contain a JSON object"] }, String(raw));
  }
});

test("normalizeConfig: never changes the defaults it was given", () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  const { config } = clean({ labels: { deps: ["x"] }, reviewers: ["a"] });
  config.labels.ready = ["changed"];
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  assert.deepEqual(clean({}).config.labels.ready, []);
});

test("parseConfig: no file is normal, the defaults and no note", () => {
  assert.deepEqual(parseConfig(null), { config: DEFAULT_CONFIG, problems: [] });
  assert.equal(configNote(parseConfig(null).problems), null);
  assert.deepEqual(parseConfig(undefined), { config: DEFAULT_CONFIG, problems: [] });
});

test("parseConfig: an empty or broken file is a problem, with the defaults", () => {
  for (const text of ["", "   ", "{ owners: [] }", "{", "[1,"]) {
    const { config, problems } = parseConfig(text);
    assert.deepEqual(config, DEFAULT_CONFIG, JSON.stringify(text));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^not valid JSON \(/);
  }
});

test("parseConfig: reads JSON, with or without a byte order mark", () => {
  assert.deepEqual(parseConfig('{ "stagingFlow": true }').config.stagingFlow, true);
  assert.deepEqual(parseConfig('﻿{ "stagingFlow": true }').config.stagingFlow, true);
  assert.deepEqual(parseConfig("[]").problems, ["the file must contain a JSON object"]);
});

test("configNote: one line naming every problem", () => {
  assert.equal(configNote([]), null);
  assert.equal(configNote(['"mergedDays" must be a whole number from 1 to 365']), 'config.json: "mergedDays" must be a whole number from 1 to 365, using defaults');
  assert.equal(configNote(["a", "b"]), "config.json: a; b, using defaults");
  assert.ok(!configNote(parseConfig("{").problems).includes("\n"));
});

test("config.example.json is valid", () => {
  const text = readFileSync(new URL("../config.example.json", import.meta.url), "utf8");
  const { config, problems } = parseConfig(text);
  assert.deepEqual(problems, []);
  assert.equal(config.owners, null, "the example does not list anybody's organization");
  assert.deepEqual(config.reviewers, ["claude"]);
  assert.ok(!/"owners"\s*:/.test(text), "owners stays out of the example (a note key explains it)");
});

test("hasLabel and isReviewer compare without regard to case", () => {
  assert.equal(hasLabel(["Bug", "Ship-It"], ["ship-it"]), true);
  assert.equal(hasLabel(["bug"], ["ship-it"]), false);
  assert.equal(hasLabel(["bug"], []), false);
  assert.equal(hasLabel(undefined, ["x"]), false);
  assert.equal(isReviewer("Claude"), false, "nobody is a reviewer by default");
  assert.equal(isReviewer("Claude", { reviewers: ["claude"] }), true);
  assert.equal(isReviewer("claude", { reviewers: [] }), false);
  assert.equal(isReviewer("priya", { reviewers: ["Priya"] }), true);
  assert.equal(isReviewer("", { reviewers: [""] }), false);
  assert.equal(isReviewer(undefined), false);
});
