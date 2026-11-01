// Reads config.json from the mod's own folder. The only part of the config that needs the
// Herdr runtime; what it may say is config.js.
import { appHome, readTextFile } from "herdr";
import { parseConfig } from "./config.js";

const MOD = "roundup";

// Always resolves to { config, problems }. A file that is not there is normal (the defaults, no
// problem); one that cannot be read is a problem, and the defaults.
export async function readConfig() {
  const path = `${appHome().replaceAll("\\", "/")}/mods/${MOD}/config.json`;
  let text;
  try { text = await readTextFile(path); }
  catch (e) {
    const { config } = parseConfig(null);
    return { config, problems: [`couldn't read the file (${String(e?.message || e).split("\n")[0]})`] };
  }
  return parseConfig(text);
}
