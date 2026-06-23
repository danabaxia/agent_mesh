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

// Denials whose signature matches one of these are INERT on an ephemeral CI runner:
// they touch the runner's own Claude config (read transcripts, write a project
// .claude/settings.json the job discards) and change nothing about whether the agent
// did its job. The model reaching for the /fewer-permission-prompts skill unprompted
// (#421) racks up exactly these — they fail the postrun gate (#432) even though the run
// otherwise worked. Drop them before the block threshold. Add other inert-on-runner
// skill markers here as they surface. NOTE: only the ARRAY form of permission_denials
// carries per-denial detail to match against; a bare permission_denials_count has no
// detail to filter and is used as-is.
export const INERT_DENIAL_SIGNATURES = [
  'fewer-permission-prompts', // the skill name (its Skill invocation + any cmd naming it)
  '.claude', // the runner's Claude config dir: settings.json it writes + transcripts it reads
];

/** True when a single permission-denial record bears an inert-on-runner signature. */
export function isInertDenial(denial) {
  if (!denial || typeof denial !== 'object') return false;
  const hay = JSON.stringify(denial).toLowerCase();
  return INERT_DENIAL_SIGNATURES.some((sig) => hay.includes(sig));
}

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
  // on a schema variant. When the array form is present it carries per-denial detail,
  // so drop INERT-on-runner denials (e.g. the /fewer-permission-prompts skill, #432)
  // before counting — a model misbehaving on an inert skill must not red a run that
  // otherwise did its job. The count-only form has no detail to filter, so use it as-is.
  let denials;
  if (envelope.permission_denials_count != null) {
    denials = Number(envelope.permission_denials_count);
  } else if (Array.isArray(envelope.permission_denials)) {
    denials = envelope.permission_denials.filter((d) => !isInertDenial(d)).length;
  } else {
    denials = 0;
  }
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
