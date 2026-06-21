// Read-only orchestrator for the merge-sweep report. Calls only read-only decision
// functions + read-only `gh` queries; never a mutating sweep. Writes one report.
import { classifyIssueGate } from '../automerge/issue-gate-sweep.js';
import { classifyAutomergePr } from '../automerge/eligibility.js';
import { classifyMemoryPr } from '../automerge/memory-classify.js';
import { buildMergeSweepReport, mergeSweepReportPath } from './report.js';

const PR_FIELDS = 'number,title,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,labels';

async function safeCp(name, fn) {
  try { return await fn(); }
  catch (e) { return { name, status: 'error', error: e?.message || String(e), items: [] }; }
}

async function memoryItem(gh, repo, pr) {
  try {
    const files = (JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'files'])).files || []).map((f) => f.path);
    const quickJsonContents = [];
    for (const f of files.filter((p) => p.endsWith('quick.json'))) {
      const out = await gh(['api', `repos/${repo}/contents/${f}?ref=${pr.headRefName}`, '--jq', '.content']);   // read-only GET
      quickJsonContents.push(Buffer.from(String(out).trim(), 'base64').toString('utf8'));
    }
    const { state, reason } = classifyMemoryPr({ number: pr.number, isCrossRepository: pr.isCrossRepository, files, quickJsonContents });
    return { ref: `PR#${pr.number}`, number: pr.number, state, detail: reason || (pr.title || '') };
  } catch {
    return { ref: `PR#${pr.number}`, number: pr.number, state: 'needs-human', detail: 'unreadable' };
  }
}

export async function runMergeSweep({ gh, repo, meshRoot, readReport, writeReport, now }) {
  // 1) issue-gate (read-only)
  const g = await classifyIssueGate({ gh, repo }).catch((e) => ({ held: [], cleared: [], error: e?.message || String(e) }));
  const gate = { held: new Set(g.held || []), cleared: new Set(g.cleared || []), ok: !g.error && !(g.errors > 0) };
  const gateItems = [
    ...(g.held || []).map((n) => ({ ref: `PR#${n}`, number: n, state: 'would-label', detail: 'linked issue blocked' })),
    ...(g.cleared || []).map((n) => ({ ref: `PR#${n}`, number: n, state: 'would-clear', detail: 'linked issue clear' })),
  ];
  const issueGateCp = {
    name: 'issue-gate',
    status: gate.ok ? (gateItems.length ? 'flagged' : 'clean') : 'error',
    error: g.error || (g.errors ? `${g.errors} per-PR error(s)` : null),
    items: gateItems,
  };

  // 2) automerge (read-only classify; gate overlay + fail-closed)
  //    memory:promote PRs are excluded here — they are handled by the memory-automerge
  //    checkpoint and always UNSTABLE (GITHUB_TOKEN recursion guard prevents CI runs).
  //    Classifying them here would produce spurious blocked:not-clean:UNSTABLE items that
  //    trigger needs-human escalations after 4+ sweeps (issue #274).
  const automergeCp = await safeCp('automerge', async () => {
    const prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS, '--limit', '100']));
    const items = (Array.isArray(prs) ? prs : [])
      .filter((pr) => !(Array.isArray(pr.labels) && pr.labels.some((l) => (l && l.name || l) === 'memory:promote')))
      .map((pr) => {
        const { state, reason } = classifyAutomergePr(pr, { gate });
        return { ref: `PR#${pr.number}`, number: pr.number, state, detail: reason || (pr.title || '') };
      });
    return { name: 'automerge', status: items.length ? 'flagged' : 'clean', items };
  });

  // 3) memory (read-only static pre-check)
  const memoryCp = await safeCp('memory-automerge', async () => {
    const prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--label', 'memory:promote', '--json', 'number,title,isCrossRepository,headRefName', '--limit', '100']));
    const items = [];
    for (const pr of (Array.isArray(prs) ? prs : [])) items.push(await memoryItem(gh, repo, pr));
    return { name: 'memory-automerge', status: items.length ? 'flagged' : 'clean', items };
  });

  const prev = readReport(mergeSweepReportPath(meshRoot)) || {};
  const report = buildMergeSweepReport([issueGateCp, automergeCp, memoryCp], prev, now);
  writeReport(mergeSweepReportPath(meshRoot), report);
  const s = report.summary;
  return s.errors ? { status: 'fail', error: `${s.errors} checkpoint error(s); ${s.flagged} flagged` }
                  : { status: 'ok', output: `${s.flagged} flagged, ${s.ok} clean (report-only)` };
}
