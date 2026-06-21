// src/automerge/memory-dispatch.js — daemon-driven memory:promote drain trigger.
//
// GitHub Actions' cron for dev-mesh-memory-automerge.yml is heavily THROTTLED
// (declared */15 but observed firing only every ~2.6h+), so memory:promote PRs
// pile up between scheduled sweeps. The daemon runs on a reliable ~10min
// scheduler, so it dispatches the (already battle-tested + retry-fixed) workflow
// when — and only when — there are open memory:promote PRs to drain. This mirrors
// the code-PR `automerge-sweep` daemon-driven prompt drain, but for memory PRs the
// merge logic lives in the workflow (union-resolve + validate + retry), so the
// daemon TRIGGERS that workflow rather than reimplementing it (GitHub Actions as a
// tool). Gating on the open-PR count avoids burning an Actions run every 10min
// when there is nothing to merge.
export async function dispatchMemoryAutomerge({ gh, repo, workflow = 'dev-mesh-memory-automerge.yml', log = () => {} }) {
  let open = [];
  try {
    const out = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--label', 'memory:promote', '--json', 'number']);
    open = JSON.parse(out || '[]');
  } catch (e) {
    log(`list memory:promote PRs failed: ${e?.message || e}`);
    return { dispatched: false, openCount: 0, error: e?.message || String(e) };
  }
  if (!Array.isArray(open) || open.length === 0) return { dispatched: false, openCount: 0 };
  await gh(['workflow', 'run', workflow, '--repo', repo]);
  log(`dispatched ${workflow} for ${open.length} open memory:promote PR(s)`);
  return { dispatched: true, openCount: open.length };
}
