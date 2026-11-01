// Pure part of the avatar cache: which URLs are downloaded, and under which file name.
// No imports: Node tests load this file too.

const HOST = "avatars.githubusercontent.com";

// The cache file name for a GitHub avatar URL, or null for anything else (only GitHub's avatar host
// is downloaded). `/u/13347022?s=64&u=33cb…&v=4` → `u-13347022-33cb27ca-v4.jpg`: the `u` hash
// changes when the person changes their picture, so a new picture is a new file. The bytes
// decide the format when the image loads, whatever the extension says.
export function avatarName(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== HOST) return null;
  const m = /^\/(u|in)\/(\d+)$/.exec(u.pathname);
  if (!m) return null;
  const hash = (u.searchParams.get("u") || "").replace(/[^0-9a-f]/gi, "").slice(0, 8);
  const v = (u.searchParams.get("v") || "").replace(/\D/g, "");
  return [m[1], m[2], hash, v && `v${v}`].filter(Boolean).join("-") + ".jpg";
}

// A failed download is tried again after this long (offline at start, GitHub hiccup).
export const RETRY_MS = 5 * 60000;
export const retryable = (failedAt, now) => failedAt !== Infinity && now - failedAt >= RETRY_MS;
