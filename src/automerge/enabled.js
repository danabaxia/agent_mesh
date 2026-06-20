// src/automerge/enabled.js — resolve whether automerge is enabled for the DAEMON sweep.
//
// The GitHub-Actions automerge reads the repo variable `vars.AUTOMERGE_ENABLED`. The daemon
// must honor the SAME operator decision, but it runs under launchd and its process env
// usually does NOT carry AUTOMERGE_ENABLED — so a plain `process.env` check leaves the
// daemon sweep permanently "disabled" while ready PRs idle (observed: 8 CLEAN+APPROVED PRs
// stuck while the repo var was `true`). Make the repo variable the single source of truth,
// with the env as an explicit fallback. Injected `readVar` keeps this unit-testable.
//
// @param {{ env?: object, readVar?: () => Promise<string|null> }} opts
//   readVar — async resolver for the repo var value (e.g. `gh variable get AUTOMERGE_ENABLED`)
// @returns {Promise<boolean>}
export async function resolveAutomergeEnabled({ env = process.env, readVar } = {}) {
  if (env && env.AUTOMERGE_ENABLED === 'true') return true; // explicit env opt-in wins
  if (typeof readVar === 'function') {
    try {
      const v = await readVar();
      return String(v).trim() === 'true';
    } catch {
      return false; // no repo-var access / gh error → stay off (safe default)
    }
  }
  return false;
}
