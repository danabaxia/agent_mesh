// src/automerge/escalation-sweep.js — impure but fully injected. Surface stale-stuck PRs
// as needs-triage issues (dedup'd) and close its OWN escalations once the PR recovers.
// Failure is data — a per-item error is logged and skipped, never aborts the sweep.
import { prNeedsEscalation, escalationTitle, escalationBody, parsePrNumber } from './escalation.js';

// Only titles this sweep itself produces — so the close pass never touches a janitor's
// "needs-triage: PR #N unlabelled and stuck" issue.
const isOwnTitle = (t) => /PR #\d+ stuck \(/.test(String(t || ''));

/**
 * @param {object} deps gh(args)→stdout; repo; enabled(===true); staleMs; now?; dryRun?; log?
 * @returns {{disabled?:boolean, opened:number[], closed:string[], error?:string}}
 */
export async function runEscalation({ gh, repo, enabled, staleMs, now = Date.now(), dryRun = false, log = () => {} }) {
  if (enabled !== true) {
    log('escalation: disabled (AUTOMERGE_ENABLED != true)');
    return { disabled: true, opened: [], closed: [] };
  }
  let prs;
  try {
    prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json',
      'number,title,url,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,updatedAt,labels', '--limit', '100']));
  } catch (e) {
    log('escalation: pr list failed: ' + (e?.message || e));
    return { opened: [], closed: [], error: e?.message || String(e) };
  }
  let triage = [];
  try {
    triage = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'needs-triage', '--json', 'number,title', '--limit', '100']));
  } catch (e) {
    log('escalation: issue list failed: ' + (e?.message || e));
  }

  const stuck = (Array.isArray(prs) ? prs : []).filter((pr) => prNeedsEscalation(pr, { now, staleMs }));
  const stuckNums = new Set(stuck.map((p) => p.number));
  const existingPrNums = new Set();           // any needs-triage issue per PR → dedup opens
  for (const iss of (Array.isArray(triage) ? triage : [])) {
    const n = parsePrNumber(iss.title);
    if (n != null) existingPrNums.add(n);
  }

  const opened = [], closed = [];
  for (const pr of stuck) {
    if (existingPrNums.has(pr.number)) continue;
    try {
      if (!dryRun) await gh(['issue', 'create', '--repo', repo, '--title', escalationTitle(pr), '--label', 'needs-triage', '--body', escalationBody(pr)]);
      opened.push(pr.number);
    } catch (e) { log(`escalation: open for PR #${pr.number} failed: ${e?.message || e}`); }
  }
  // self-clean: close OUR escalations whose PR is no longer stuck
  for (const iss of (Array.isArray(triage) ? triage : [])) {
    const n = parsePrNumber(iss.title);
    if (n == null || !isOwnTitle(iss.title) || stuckNums.has(n)) continue;
    try {
      if (!dryRun) await gh(['issue', 'close', String(iss.number), '--repo', repo, '--comment', '🤖 dev-mesh: PR is no longer stuck — closing this escalation.']);
      closed.push(String(iss.number));
    } catch (e) { log(`escalation: close issue #${iss.number} failed: ${e?.message || e}`); }
  }
  log(`escalation: opened [${opened.join(',')}] · closed [${closed.join(',')}]${dryRun ? ' (dry-run)' : ''}`);
  return { opened, closed };
}
