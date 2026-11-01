// The optional config.json: what it may say, and what the panel does without it. Pure, no
// imports: loaded by Node tests and by the Herdr runtime, which reads the file (config-file.js).
//
// Every field is optional. A field that is missing keeps its default; a field that is invalid
// is reported (see `problems`) and also keeps its default; a file that cannot be parsed at all
// means the defaults for everything.

export const DEFAULT_MERGED_DAYS = 7;

export const DEFAULT_CONFIG = Object.freeze({
  owners: null,                      // null: the signed-in user and their organizations (looked up once per run)
  stagingFlow: false,
  labels: Object.freeze({ ready: Object.freeze([]), review: Object.freeze([]), deps: Object.freeze(["dependencies"]) }),
  reviewers: Object.freeze([]),       // nobody: comments are not read as reviews until the person names a reviewer
  mergedDays: DEFAULT_MERGED_DAYS,
});

const FIELDS = new Set(Object.keys(DEFAULT_CONFIG));
const LABEL_KEYS = ["ready", "review", "deps"];
const MAX_MERGED_DAYS = 365;
// A GitHub user or organization name. These end up inside a search string, so anything that is
// not a plain name (a space, a colon, a quote) is refused rather than passed on.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const unique = (list) => [...new Set(list)];
// Unknown keys are reported (a typo such as "owner" would otherwise do nothing, silently); keys
// that start with "_" or "$" are for the person's own notes.
const unknownKeys = (obj, known) => Object.keys(obj).filter((k) => !known.has(k) && !/^[_$]/.test(k));

// A list of non-empty strings, trimmed and without repeats; null when it is not one.
function stringList(value) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) return null;
  return unique(value.map((v) => v.trim()));
}

// raw: whatever JSON.parse gave (or anything else). Always returns a complete config.
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, labels: { ...DEFAULT_CONFIG.labels } };
  const problems = [];
  if (!isObject(raw)) {
    problems.push("the file must contain a JSON object");
    return { config, problems };
  }
  for (const key of unknownKeys(raw, FIELDS)) problems.push(`unknown field "${key}"`);

  if (raw.owners !== undefined) {
    const owners = stringList(raw.owners);
    if (!owners) problems.push('"owners" must be a list of GitHub user or organization names');
    else if (owners.some((o) => !OWNER.test(o))) problems.push(`"owners" has a name that is not a GitHub login: ${owners.find((o) => !OWNER.test(o))}`);
    else if (owners.length > 0) config.owners = owners; // an empty list means "look them up"
  }

  if (raw.stagingFlow !== undefined) {
    if (typeof raw.stagingFlow === "boolean") config.stagingFlow = raw.stagingFlow;
    else problems.push('"stagingFlow" must be true or false');
  }

  if (raw.labels !== undefined) {
    if (!isObject(raw.labels)) problems.push('"labels" must be an object with ready, review and deps lists');
    else {
      for (const key of unknownKeys(raw.labels, new Set(LABEL_KEYS))) problems.push(`unknown field "labels.${key}"`);
      for (const key of LABEL_KEYS) {
        if (raw.labels[key] === undefined) continue;
        const list = stringList(raw.labels[key]);
        if (list) config.labels[key] = list;
        else problems.push(`"labels.${key}" must be a list of label names`);
      }
    }
  }

  if (raw.reviewers !== undefined) {
    const list = stringList(raw.reviewers);
    if (list) config.reviewers = list; // an empty list is allowed: nobody is highlighted as the reviewer
    else problems.push('"reviewers" must be a list of GitHub logins');
  }

  if (raw.mergedDays !== undefined) {
    const n = raw.mergedDays;
    if (Number.isInteger(n) && n >= 1 && n <= MAX_MERGED_DAYS) config.mergedDays = n;
    else problems.push(`"mergedDays" must be a whole number from 1 to ${MAX_MERGED_DAYS}`);
  }
  return { config, problems };
}

// The file's text (null: there is no file, which is normal) to { config, problems }.
export function parseConfig(text) {
  if (text == null) return { config: normalizeConfig({}).config, problems: [] };
  let raw;
  try { raw = JSON.parse(String(text).replace(/^﻿/, "")); }
  catch (e) {
    const { config } = normalizeConfig({});
    return { config, problems: [`not valid JSON (${String(e?.message || e).split("\n")[0]})`] };
  }
  return normalizeConfig(raw);
}

// The one line the panel shows when the file had a problem; null when it had none.
export const configNote = (problems) =>
  problems.length === 0 ? null : `config.json: ${problems.join("; ")}, using defaults`;

// Labels and logins are compared without regard to case: GitHub treats them that way.
const lower = (s) => String(s ?? "").toLowerCase();
export const hasLabel = (labels, wanted) => {
  const have = new Set((labels || []).map(lower));
  return (wanted || []).some((w) => have.has(lower(w)));
};
export const isReviewer = (login, config = DEFAULT_CONFIG) =>
  Boolean(login) && (config.reviewers || []).some((r) => lower(r) === lower(login));
