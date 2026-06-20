// src/gh-labels.js — make GitHub issue-filing self-healing for labels.
//
// `gh issue create --label X` FAILS with a 422 when label X does not yet exist
// in the repo (gh validates labels server-side; it does NOT auto-create them).
// Every autonomous mesh filer (analyst ideas, MIR regressions, daemon heartbeat,
// automerge escalation) assumed its labels pre-existed — so a brand-new label
// (e.g. `generated:analyst`, `generated:mesh-scan`, `regression`) silently broke
// the whole run on first use. This is the systematic fix: call ensureLabels(...)
// once before any filing loop so missing labels are created idempotently.
//
// Pure-shell: takes the injected `gh` executor (array args -> Promise<stdout>),
// so it is unit-testable with a fake gh and reuses each caller's auth/cwd/repo.

const DEFAULT_COLOR = 'ededed'; // GitHub's neutral grey; the label only needs to EXIST

/**
 * Ensure each label exists before it is used on `gh issue create --label`.
 * Idempotent and best-effort: an "already exists" (or any) failure on one label
 * never throws and never blocks the others — the subsequent issue-create surfaces
 * any real auth/repo error loudly.
 *
 * @param {(args: string[]) => Promise<string>} gh  injected gh executor
 * @param {string[]} labels                          label names to ensure
 * @param {{ repo?: string, color?: string }} [opts]
 * @returns {Promise<{ attempted: string[] }>}
 */
export async function ensureLabels(gh, labels, { repo, color = DEFAULT_COLOR } = {}) {
  const uniq = [...new Set((labels || []).filter((l) => typeof l === 'string' && l.length > 0))];
  for (const name of uniq) {
    const args = ['label', 'create', name, '--color', color];
    if (repo) args.push('--repo', repo);
    try {
      await gh(args);
    } catch {
      // "already exists" is the normal idempotent case; any other failure is left
      // for the real `gh issue create` to report. Never block filing on a label.
    }
  }
  return { attempted: uniq };
}
