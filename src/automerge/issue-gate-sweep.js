// src/automerge/issue-gate-sweep.js — impure but fully injected. For each open PR,
// resolve its linked issues and add/remove the blocked-by-issue label so the auto-merge
// gate blocks a PR whose issue is blocked/rejected/wontfix/duplicate. Failure is data —
// a per-PR error is logged and skipped, never aborts the sweep.
import { shouldHoldForIssues, gateDecision, ISSUE_HOLD_LABEL } from './issue-gate.js';

const names = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);

/**
 * @param {object} deps
 *   gh(args) → stdout string (injected); repo 'owner/name'; enabled (must be === true);
 *   dryRun?  boolean; log? (msg)=>void
 * @returns {{disabled?:boolean, held:number[], cleared:number[], errors?:number}}
 */
// Read-only: list PRs, resolve linked issues, decide held/cleared. NO label edits.
export async function classifyIssueGate({ gh, repo, log = () => {} }) {
  let prs;
  try {
    prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,labels', '--limit', '100']));
  } catch (e) {
    log('issue-gate: pr list failed: ' + (e?.message || e));
    return { held: [], cleared: [], error: e?.message || String(e) };
  }
  const held = [], cleared = []; let errors = 0;
  for (const pr of (Array.isArray(prs) ? prs : [])) {
    try {
      const view = JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'closingIssuesReferences']));
      const issueNums = (view.closingIssuesReferences || []).map((r) => r && r.number).filter(Boolean);
      const labelSets = [];
      for (const n of issueNums) {
        const iss = JSON.parse(await gh(['issue', 'view', String(n), '--repo', repo, '--json', 'labels']));
        labelSets.push(names(iss.labels));
      }
      const action = gateDecision(names(pr.labels), shouldHoldForIssues(labelSets));
      if (action === 'add') held.push(pr.number);
      else if (action === 'remove') cleared.push(pr.number);
    } catch (e) { errors++; log(`issue-gate: #${pr.number} skipped: ${e?.message || e}`); }
  }
  return { held, cleared, errors };
}

export async function runIssueGate({ gh, repo, enabled, dryRun = false, log = () => {} }) {
  if (enabled !== true) { log('issue-gate: disabled (AUTOMERGE_ENABLED != true)'); return { disabled: true, held: [], cleared: [] }; }
  const r = await classifyIssueGate({ gh, repo, log });
  if (r.error) return r;
  if (!dryRun) {
    for (const n of r.held)    await gh(['pr', 'edit', String(n), '--repo', repo, '--add-label', ISSUE_HOLD_LABEL]);
    for (const n of r.cleared) await gh(['pr', 'edit', String(n), '--repo', repo, '--remove-label', ISSUE_HOLD_LABEL]);
  }
  log(`issue-gate: held [${r.held.join(',')}] · cleared [${r.cleared.join(',')}]${dryRun ? ' (dry-run)' : ''} · errors ${r.errors}`);
  return { held: r.held, cleared: r.cleared, errors: r.errors };
}
