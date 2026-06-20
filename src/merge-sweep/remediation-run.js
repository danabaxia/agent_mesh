// src/merge-sweep/remediation-run.js — impure orchestration for ②. Injected gh + fs.
// Read-mostly: gh issue list (needs-human --state all, needs-triage), gh pr view (pre-file guard);
// writes only gh issue create/close, gh label create (idempotent), and the state file.
import { join } from 'node:path';
import { planRemediation, markerFor, MARKER_RE } from './remediation.js';
import { parsePrNumber } from '../automerge/escalation.js';

export const remediationPath = (meshRoot) => join(meshRoot, 'mesh', 'reports', 'merge-sweep-remediation.json');
const EXEMPT = new Set(['exempt', 'pinned']);
const labelNames = (iss) => (Array.isArray(iss.labels) ? iss.labels.map((l) => (typeof l === 'string' ? l : l && l.name)) : []);

export async function runRemediation({ gh, repo, meshRoot, readReport, readState, writeState, now, cfg, log = () => {} }) {
  const report = readReport();
  if (!report || report.available === false) {
    return { status: 'fail', error: 'merge-sweep report unavailable — no remediation this tick (state preserved)' };
  }
  const prev = readState() || {};

  let ownList = [];
  try { ownList = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'all', '--label', 'needs-human', '--json', 'number,state,body,labels', '--limit', '200'])); } catch (e) { log('remediate: needs-human list failed: ' + (e?.message || e)); }
  const ownIssues = {};
  for (const iss of (Array.isArray(ownList) ? ownList : [])) {
    const m = MARKER_RE.exec(String(iss.body || ''));
    if (!m) continue;
    const open = String(iss.state).toUpperCase() === 'OPEN';
    const cur = ownIssues[m[1]];
    if (!cur || (open && !cur.open)) ownIssues[m[1]] = { issueNumber: iss.number, open, exempt: labelNames(iss).some((n) => EXEMPT.has(n)) };
  }

  let triage = [];
  try { triage = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'needs-triage', '--json', 'number,title', '--limit', '100'])); } catch (e) { log('remediate: needs-triage list failed: ' + (e?.message || e)); }
  const triagePrNums = new Set();
  for (const iss of (Array.isArray(triage) ? triage : [])) { const n = parsePrNumber(iss.title); if (n != null) triagePrNums.add(n); }

  const plan = planRemediation({ report, prev, ownIssues, triagePrNums, now, cfg });
  const state = { ...plan.nextState };

  let ensured = false;
  for (const f of plan.file) {
    try {
      if (Number.isInteger(f.number)) {
        const pv = JSON.parse(await gh(['pr', 'view', String(f.number), '--repo', repo, '--json', 'state']));
        if (pv && String(pv.state).toUpperCase() !== 'OPEN') { state[f.key] = prev[f.key] || { state: 'watching' }; continue; }
      }
      if (!ensured) { try { await gh(['label', 'create', 'needs-human', '--repo', repo, '--color', 'B60205']); } catch { /* exists */ } ensured = true; }
      const title = f.checkpoint === 'automerge'
        ? `needs-human: ${f.ref} stuck (${f.detail}) — auto-fix exhausted`
        : `needs-human: ${f.ref} (${f.detail || 'memory review'})`;
      const body = `${markerFor(f.key)}\n\n🤖 dev-mesh ② backstop: this item has been flagged for ≥${cfg.escalateAfter} sweeps and the automatic fixers could not clear it. A human review is needed.\n\n- item: \`${f.key}\`\n- detail: ${f.detail || ''}`;
      const url = await gh(['issue', 'create', '--repo', repo, '--label', 'needs-human', '--title', title, '--body', body]);
      const n = Number.parseInt(String(url).trim().split('/').pop(), 10);
      state[f.key] = { ...state[f.key], state: 'escalated', issueNumber: Number.isFinite(n) ? n : null };
    } catch (e) { log(`remediate: file ${f.key} failed: ${e?.message || e}`); state[f.key] = prev[f.key] || { state: 'watching' }; }
  }
  for (const c of plan.close) {
    try { await gh(['issue', 'close', String(c.issueNumber), '--repo', repo, '--comment', '🤖 dev-mesh ②: item resolved — closing this escalation.']); state[c.key] = { ...state[c.key], state: 'done' }; }
    catch (e) { log(`remediate: close ${c.key} failed: ${e?.message || e}`); state[c.key] = prev[c.key]; }
  }

  writeState(remediationPath(meshRoot), state);
  return { status: 'ok', output: `escalated ${plan.file.length}, closed ${plan.close.length}, tracking ${Object.keys(state).length}` };
}
