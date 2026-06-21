// src/automerge/review-respond-dispatch.js — daemon-driven review-respond trigger.
//
// GitHub Actions' cron for dev-mesh-review-respond.yml is heavily THROTTLED
// (declared frequent but observed firing only ~every 3-5h), so PRs the Reviewer
// marked CHANGES_REQUESTED stall for hours waiting for the responder to address
// the feedback. That gates the WHOLE code pipeline (most first-draft PRs get
// CHANGES_REQUESTED) and even causes false `needs-human` escalations when the
// merge-sweep ② backstop flags a slowly-progressing PR as "fixers couldn't clear
// it". The daemon runs on a reliable ~10min scheduler, so it dispatches the
// (battle-tested) responder workflow when — and only when — there are open
// non-draft PRs in CHANGES_REQUESTED. Mirrors the memory-automerge daemon drain
// (memory-dispatch.js): the daemon is the reliable trigger, the workflow stays the
// logic (GitHub Actions as a tool). Gating on the count avoids burning an Actions
// run every 10min when there is nothing to respond to.
export async function dispatchReviewRespond({ gh, repo, workflow = 'dev-mesh-review-respond.yml', log = () => {} }) {
  let prs = [];
  try {
    const out = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,reviewDecision,isDraft', '--limit', '100']);
    prs = JSON.parse(out || '[]');
  } catch (e) {
    log(`list CHANGES_REQUESTED PRs failed: ${e?.message || e}`);
    return { dispatched: false, pendingCount: 0, error: e?.message || String(e) };
  }
  const pending = (Array.isArray(prs) ? prs : []).filter((p) => p && p.isDraft === false && p.reviewDecision === 'CHANGES_REQUESTED');
  if (pending.length === 0) return { dispatched: false, pendingCount: 0 };
  await gh(['workflow', 'run', workflow, '--repo', repo]);
  log(`dispatched ${workflow} for ${pending.length} CHANGES_REQUESTED PR(s)`);
  return { dispatched: true, pendingCount: pending.length };
}
