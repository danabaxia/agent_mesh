// src/automerge/mergefix-dispatch.js — daemon-driven conflict-resolution trigger.
//
// dev-mesh-mergefix.yml resolves a DIRTY (conflicting) same-repo PR by driving the
// Coder to merge main in — but its resolve steps are gated to NON-push events
// (`github.event_name != 'push'`): a push-triggered run only DETECTS the conflict,
// and the only other trigger is a throttled GH `schedule` (~hourly). So an APPROVED
// PR that goes DIRTY (main advanced past it) sits unresolved for hours and then gets
// falsely escalated needs-human by the merge-sweep ② backstop (live: #376 escalated
// the approved-but-DIRTY #364). That blocks AUTONOMOUS completion of an approved PR.
// The daemon's reliable ~10min cadence dispatches mergefix (a workflow_dispatch event
// => non-push => resolves) when — and only when — there is an open non-draft same-repo
// DIRTY PR. Mirrors the memory-automerge / review-respond daemon drains: the daemon is
// the reliable trigger, the workflow stays the resolution logic (GitHub Actions as a
// tool). Gating on the dirty count avoids burning an Actions run with nothing to fix.
export async function dispatchMergefix({ gh, repo, workflow = 'dev-mesh-mergefix.yml', log = () => {} }) {
  let prs = [];
  try {
    const out = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,mergeStateStatus,mergeable,isDraft,isCrossRepository', '--limit', '100']);
    prs = JSON.parse(out || '[]');
  } catch (e) {
    log(`list DIRTY PRs failed: ${e?.message || e}`);
    return { dispatched: false, dirtyCount: 0, error: e?.message || String(e) };
  }
  const dirty = (Array.isArray(prs) ? prs : []).filter((p) =>
    p && p.isDraft === false && p.isCrossRepository === false
    && (p.mergeStateStatus === 'DIRTY' || p.mergeable === 'CONFLICTING'));
  if (dirty.length === 0) return { dispatched: false, dirtyCount: 0 };
  await gh(['workflow', 'run', workflow, '--repo', repo]);
  log(`dispatched ${workflow} for ${dirty.length} DIRTY PR(s)`);
  return { dispatched: true, dirtyCount: dirty.length };
}
