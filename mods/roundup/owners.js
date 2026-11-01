// Whose pull requests and issues the panel lists when config.json does not say. Pure, no imports:
// the gh calls are passed in (github.js), so Node tests can stand in for them.

const message = (e) => String(e?.message || e);

// gh's own wording when nobody is signed in, or the token is no longer good.
const signedOut = (text) => /gh auth login|not logged in|authentication required|bad credentials|http 401/i.test(text);

// The signed-in user and their organizations. `lines(args)` runs gh and resolves with the output's
// non-empty lines, or rejects with a readable Error. Both lookups start together, but the login is
// judged first: signed out, the organizations call fails the same way, and the useful message is
// "run gh auth login", not a hint to set "owners" (which would not help: every query needs gh signed in).
export async function lookupOwners(lines) {
  const loginCall = lines(["api", "user", "--jq", ".login"]);
  const orgsCall = lines(["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
  orgsCall.catch(() => {}); // judged below, after the login; never an unhandled rejection
  let login;
  try { login = await loginCall; }
  catch (e) {
    throw new Error(signedOut(message(e))
      ? `You're not signed in to GitHub. Run gh auth login (gh said: ${message(e)})`
      : `Couldn't look up your GitHub login: ${message(e)}`);
  }
  let orgs;
  try { orgs = await orgsCall; }
  catch (e) {
    throw new Error(signedOut(message(e))
      ? `You're not signed in to GitHub. Run gh auth login (gh said: ${message(e)})`
      : `Couldn't look up your GitHub organizations: ${message(e)}. Set "owners" in config.json to skip the lookup`);
  }
  const owners = [...new Set([...login, ...orgs])];
  if (owners.length === 0) throw new Error("GitHub didn't say who you are. Run gh auth login, or set \"owners\" in config.json");
  return owners;
}

// `fn` is called once and its promise kept, for as long as it works: a rejection is dropped, so the
// next call tries again. Callers that arrive while it is still running share the one promise.
export function onceUntilFailure(fn) {
  let kept = null;
  return () => {
    if (!kept) {
      const p = fn();
      kept = p;
      p.catch(() => { if (kept === p) kept = null; });
    }
    return kept;
  };
}
