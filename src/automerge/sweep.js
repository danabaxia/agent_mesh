// Impure but fully injected: list open PRs via gh, merge the auto-mergeable ones.
// Failure is data — a per-PR merge error is logged + counted, never aborts the sweep.
import { isAutoMergeable, DEFAULT_HOLD_LABELS } from './eligibility.js';

const PR_FIELDS = 'number,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,labels';

/**
 * @param {object} deps
 *   gh(args)        → stdout string (injected)
 *   repo            'owner/name'
 *   enabled         boolean (must be exactly true to act)
 *   holdLabels?     string[]
 *   dryRun?         boolean
 *   log?            (msg) => void
 * @returns {{disabled?:boolean, merged:number[], skipped:number, ineligible:number, error?:string}}
 */
export async function runSweep({ gh, repo, enabled, holdLabels = DEFAULT_HOLD_LABELS, dryRun = false, log = () => {} }) {
  if (enabled !== true) {
    log('automerge: disabled (AUTOMERGE_ENABLED != true)');
    return { disabled: true, merged: [], skipped: 0, ineligible: 0 };
  }
  let prs;
  try {
    prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS, '--limit', '100']));
  } catch (e) {
    log('automerge: pr list failed: ' + (e?.message || e));
    return { merged: [], skipped: 0, ineligible: 0, error: e?.message || String(e) };
  }
  const list = Array.isArray(prs) ? prs : [];
  const eligible = list.filter((pr) => isAutoMergeable(pr, { holdLabels }));
  const ineligible = list.length - eligible.length;
  const merged = [], skipped = [];
  for (const pr of eligible) {
    if (dryRun) { merged.push(pr.number); continue; }
    try {
      await gh(['pr', 'merge', String(pr.number), '--repo', repo, '--merge', '--delete-branch']);
      merged.push(pr.number);
    } catch (e) {
      skipped.push(pr.number);
      log(`automerge: #${pr.number} merge failed (retry next sweep): ${e?.message || e}`);
    }
  }
  log(`automerge: merged [${merged.join(',')}]${dryRun ? ' (dry-run)' : ''} · skipped ${skipped.length} · ineligible ${ineligible}`);
  return { merged, skipped: skipped.length, ineligible };
}
