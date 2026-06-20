// src/dev-society/autofix-sweep.js — injected sweep: detects `bug + pr:in-review` issues
// whose linked PR was closed without merging and transitions them to `blocked`. Failure is
// data — a per-item error is logged and skipped; always exits 0 (cron-safe).
import { isAutofixIssue, abandonedAutofixPlan } from './core.js';

/**
 * @param {object} deps  gh(args)→stdout string; repo; enabled(===true); dryRun?; log?
 * @returns {{disabled?:boolean, escalated:number[], error?:string}}
 */
export async function runAutofixSweep({ gh, repo, enabled, dryRun = false, log = () => {} }) {
  if (enabled !== true) {
    log('autofix-sweep: disabled (AUTOMERGE_ENABLED != true)');
    return { disabled: true, escalated: [] };
  }

  let candidates;
  try {
    candidates = JSON.parse(await gh([
      'issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'bug', '--label', 'pr:in-review',
      '--json', 'number,title,labels', '--limit', '100',
    ]));
  } catch (e) {
    log('autofix-sweep: issue list failed: ' + (e?.message || e));
    return { escalated: [], error: e?.message || String(e) };
  }

  const escalated = [];
  for (const issue of (Array.isArray(candidates) ? candidates : [])) {
    if (!isAutofixIssue(issue)) continue;
    try {
      const openPrs = JSON.parse(await gh([
        'pr', 'list', '--repo', repo, '--state', 'open',
        '--search', `#${issue.number}`, '--json', 'number', '--limit', '5',
      ]));
      // An open PR means the autofix is still in flight — not abandoned yet.
      if (Array.isArray(openPrs) && openPrs.length > 0) continue;

      const plan = abandonedAutofixPlan();
      log(`autofix-sweep: #${issue.number} has no open PR — escalating to blocked${dryRun ? ' (dry-run)' : ''}`);
      if (!dryRun) {
        await gh(['issue', 'edit', String(issue.number), '--repo', repo,
          '--add-label', plan.add.join(','), '--remove-label', plan.remove.join(',')]);
        await gh(['issue', 'comment', String(issue.number), '--repo', repo,
          '--body', plan.comment]);
      }
      escalated.push(issue.number);
    } catch (e) {
      log(`autofix-sweep: issue #${issue.number} skipped (${e?.message || e})`);
    }
  }
  log(`autofix-sweep: escalated [${escalated.join(',')}]${dryRun ? ' (dry-run)' : ''}`);
  return { escalated };
}
