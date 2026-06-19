// Pure: map GitHub-Actions workflow runs → mesh activity records (buildActivity
// shape) with the orchestrator as the hub. Impure pollGhActivity (added in a later
// task) runs `gh run list` and writes the cache the dashboard reads.

// Workflow → role-agent convention (the dev-mesh-<role> naming, prefix stripped).
const ROLE = {
  research: 'analyst', intake: 'analyst', backlog: 'maintainer', triage: 'triager',
  review: 'reviewer', 'review-respond': 'reviewer', curate: 'curator',
  autofix: 'coder', 'ci-sweep': 'coder', mergefix: 'coder',
  dogfood: 'orchestrator', health: 'orchestrator', 'memory-automerge': 'orchestrator', 'pr-janitor': 'orchestrator',
};

export function workflowToAgent(workflowName) {
  const key = String(workflowName || '').replace(/^dev-mesh-/, '');
  return ROLE[key] || 'orchestrator';
}

/**
 * @param {object[]} runs  `gh run list --json …` rows
 * @returns activity records (buildActivity shape). Per run: a node-state record
 *   (agent working/done) and — unless the run maps to the orchestrator itself —
 *   an a2a edge record orchestrator→agent (the hub). finished_at set when done.
 * @note Caller is responsible for passing de-duplicated runs; this transform does
 *   not deduplicate. The gh-activity cache is rewritten in full each poll, which
 *   is the dedup point.
 */
export function runsToActivityRecords(runs, { now = () => new Date() } = {}) {
  const out = [];
  for (const r of (Array.isArray(runs) ? runs : [])) {
    if (!r || r.databaseId == null) continue;
    const agent = workflowToAgent(r.workflowName);
    const id = `gh-${r.databaseId}`;
    const completed = r.status === 'completed';
    const finishedAt = completed ? (r.updatedAt || now().toISOString()) : undefined;
    out.push({ id, agent, route: `ci:${r.workflowName || ''}`, started_at: r.createdAt, ...(finishedAt ? { finished_at: finishedAt } : {}) });
    if (agent !== 'orchestrator') {
      out.push({
        id: `${id}:e`, kind: 'a2a', from: 'orchestrator', to: agent, mode: 'ci',
        status: completed ? (r.conclusion || null) : null,
        started_at: r.createdAt, at: r.createdAt, ...(finishedAt ? { finished_at: finishedAt } : {}),
      });
    }
  }
  return out;
}
