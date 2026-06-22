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
 *   status ∈ 'ok' | 'errored' | 'noop' | 'blocked' | 'unknown'
 */
// Real "blocked" runs had 25–28 denials; 5 = clearly misconfigured (well below that),
// while tolerating a couple of incidental denials from an agent probing a tool.
export const BLOCKED_DENIALS_THRESHOLD = 5;

// A transient HTTP 529 "overloaded" from the Claude API is NOT a real failure: the model
// never got to do the work because the API was briefly saturated. claude-code-action burns
// its internal retries (~5 min) then reports {is_error:true, api_error_status:"overloaded_error"}.
// We classify that distinctly (status:'overloaded', retryable) so the per-workflow honesty
// gate can soft-pass it — no false-red on the run history, no human escalation — and let the
// workflow's scheduled cadence re-run it on the next tick. (#385/#386)
const OVERLOAD_RE = /overload|\b529\b/i;

/** True when an errored envelope's failure is a transient API overload (HTTP 529). */
export function isTransientOverload(envelope) {
  if (!envelope || typeof envelope !== 'object' || envelope.is_error !== true) return false;
  // The overload signal lands in api_error_status ("overloaded_error") in real envelopes;
  // tolerate it surfacing in the result/error/subtype text too across schema variants.
  for (const f of [envelope.api_error_status, envelope.result, envelope.error, envelope.subtype]) {
    if (typeof f === 'string' && OVERLOAD_RE.test(f)) return true;
  }
  return false;
}

export function classifyRunHealth(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { healthy: false, status: 'unknown', reason: 'no result envelope to inspect' };
  }
  if (envelope.is_error === true) {
    const ms = envelope.duration_ms ?? '?';
    if (isTransientOverload(envelope)) {
      return { healthy: false, status: 'overloaded', retryable: true, reason: `transient API overload (529) after ${ms}ms — retryable` };
    }
    return { healthy: false, status: 'errored', reason: `model run errored (is_error) after ${ms}ms` };
  }
  const cost = Number(envelope.total_cost_usd ?? 0);
  const turns = Number(envelope.num_turns ?? 0);
  // Don't key off cost: subscription (OAuth) auth reports $0 even on success, so a
  // cost-based "no-op" check false-fails every subscription run. The reliable
  // signals are is_error (above) and turns. Zero turns ⇒ nothing ran.
  if (turns === 0) {
    return { healthy: false, status: 'noop', reason: 'green but did no work (0 turns) — nothing ran' };
  }
  // "Ran but blocked": the model worked many turns yet a wall of permission denials
  // means it couldn't actually act (push/PR/comment) — looks green, produces nothing.
  // (e.g. tool grants missing or mis-specified — the 2026-06-15 Bash(git) vs git:* bug.)
  // The envelope reports denials in TWO observed forms: `permission_denials_count`
  // (a number — seen in real backlog run envelopes: 28, 25, 0) and `permission_denials`
  // (an array — seen in show_full_output envelopes). Handle both so the gate can't die
  // on a schema variant.
  const denials = Number(
    envelope.permission_denials_count
      ?? (Array.isArray(envelope.permission_denials) ? envelope.permission_denials.length : 0),
  );
  if (denials >= BLOCKED_DENIALS_THRESHOLD) {
    return { healthy: false, status: 'blocked', reason: `ran but was blocked — ${denials} permission denials (missing/incorrect tool grants?)` };
  }
  const billed = cost > 0 ? `$${cost.toFixed(4)}` : '$0 (subscription)';
  return { healthy: true, status: 'ok', reason: `ok (${turns} turns, ${billed})` };
}

/**
 * Pull the terminal result envelope out of whatever claude-code-action /
 * `claude -p --output-format json` wrote: a stream-json array of events, a single
 * result object, or a {result:{…}} wrapper. Returns null when none is present.
 */
export function extractResultEnvelope(parsed) {
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i] && typeof parsed[i] === 'object' && parsed[i].type === 'result') return parsed[i];
    }
    return null;
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.type === 'result' || 'is_error' in parsed) return parsed;
    if (parsed.result && typeof parsed.result === 'object') return parsed.result;
  }
  return null;
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
