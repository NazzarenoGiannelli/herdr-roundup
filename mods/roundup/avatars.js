// Profile pictures for the detail. Herdr's image() only loads files under its own home, so each
// avatar is downloaded once per run with curl (Windows 10+ and Linux ship it) into
// data/roundup/avatars/ and drawn from there. Until it is there, or if it fails, the
// initial in a circle stands in (detail.js).
import { exec, appHome } from "herdr";
import { avatarName, retryable } from "./avatars-logic.js";

const DIR = "data/roundup/avatars";
const MAX_AT_ONCE = 3;

const ready = new Map();   // url -> path for image(), relative to the app home
const pending = new Set(); // urls being downloaded
const failed = new Map();  // url -> when it failed

// The picture's path, or null while it is not downloaded.
export const avatarPath = (url) => (url && ready.get(url)) || null;

let active = 0;
const waiting = [];
const acquire = () => active < MAX_AT_ONCE ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

// Starts the downloads the given URLs still need. Safe to call on every render: each URL is
// fetched once (a failure again after a while). Re-renders when a picture arrives.
export function ensureAvatars(urls, cx) {
  const now = Date.now();
  for (const url of new Set(urls)) {
    if (!url || ready.has(url) || pending.has(url) || (failed.has(url) && !retryable(failed.get(url), now))) continue;
    const name = avatarName(url);
    if (!name) { failed.set(url, Infinity); continue; } // not a GitHub avatar: never fetched
    pending.add(url);
    cx.spawn(async cx => {
      await acquire();
      const rel = `${DIR}/${name}`;
      const abs = `${appHome().replaceAll("\\", "/")}/${rel}`;
      try {
        const r = await exec("curl", ["-fsSL", "--max-time", "15", "--create-dirs", "-o", abs, url]);
        if (r.code === 0) { ready.set(url, rel); failed.delete(url); } else failed.set(url, Date.now());
      } catch { failed.set(url, Date.now()); }
      pending.delete(url);
      release();
      if (ready.has(url)) cx.notify();
    });
  }
}
