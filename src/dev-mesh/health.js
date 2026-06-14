// src/dev-mesh/health.js — PURE health assessment for the self-hosting Dev-mesh.
//
// Hard lesson (2026-06-14): a GitHub Actions job goes GREEN even when the Claude
// run inside claude-code-action errored instantly — the first live intake run
// reported {is_error:true, total_cost_usd:0, num_turns:1} yet the job "succeeded",
// masking a do-nothing loop. So job conclusion is NOT a health signal. The only
// honest signal is the run's RESULT ENVELOPE (is_error / cost / turns). This module
// classifies that, plus conformance drift, so a scheduled monitor can tell whether
// the society is actually working — not merely whether CI is green.
// Spec: docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md §6 (Phase 1)

/**
 * Classify a single Claude result envelope (from claude-code-action's
 * claude-execution-output.json, or `claude -p --output-format json`).
 * Returns { healthy, status, reason }.
 *   status ∈ 'ok' | 'errored' | 'noop' | 'unknown'
 */
export function classifyRunHealth(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { healthy: false, status: 'unknown', reason: 'no result envelope to inspect' };
  }
  if (envelope.is_error === true) {
    const ms = envelope.duration_ms ?? '?';
    return { healthy: false, status: 'errored', reason: `model run errored (is_error) after ${ms}ms` };
  }
  const cost = Number(envelope.total_cost_usd ?? 0);
  const turns = Number(envelope.num_turns ?? 0);
  // The masking pattern: green job, but $0 spent in ≤1 turn ⇒ the model did no real
  // work (e.g. an instant model/auth error the action swallowed into a "success").
  if (cost === 0 && turns <= 1) {
    return {
      healthy: false,
      status: 'noop',
      reason: `green but did no work ($0 in ${turns} turn${turns === 1 ? '' : 's'}) — likely an instant model error`,
    };
  }
  return { healthy: true, status: 'ok', reason: `ok (${turns} turns, $${cost.toFixed(4)})` };
}

/**
 * Aggregate mesh health from probe runs + a conformance report.
 *   runs: [{ name, envelope }]      — e.g. the dogfood canary's result envelope
 *   conformanceFlags: string[]      — doctor's wiring/drift flags (empty = clean)
 * Returns { healthy, summary, runHealth, conformanceFlags }.
 */
export function assessMesh({ runs = [], conformanceFlags = [] } = {}) {
  const runHealth = runs.map((r) => ({ name: r?.name ?? '(unnamed)', ...classifyRunHealth(r?.envelope) }));
  const unhealthy = runHealth.filter((r) => !r.healthy);
  const healthy = unhealthy.length === 0 && conformanceFlags.length === 0;
  const summary = healthy
    ? `mesh healthy — ${runHealth.length} probe(s) ok, conformance clean`
    : `UNHEALTHY — ${unhealthy.length}/${runHealth.length} probe(s) failing, ${conformanceFlags.length} conformance flag(s)`;
  return { healthy, summary, runHealth, conformanceFlags };
}

/** Render a health report as a Markdown block (for a job summary / issue comment). */
export function renderHealthReport(assessment) {
  const { healthy, summary, runHealth, conformanceFlags } = assessment;
  const lines = [`## Dev-mesh health: ${healthy ? '🟢 healthy' : '🔴 unhealthy'}`, '', summary, ''];
  if (runHealth.length) {
    lines.push('| Probe | Status | Detail |', '|---|---|---|');
    for (const r of runHealth) {
      const icon = r.healthy ? '🟢' : '🔴';
      lines.push(`| ${r.name} | ${icon} ${r.status} | ${r.reason} |`);
    }
    lines.push('');
  }
  if (conformanceFlags.length) {
    lines.push('### Conformance flags', ...conformanceFlags.map((f) => `- ${f}`), '');
  }
  return lines.join('\n');
}
