// test/dev-mesh-health.test.js — the Dev-mesh health classifier (pure).
// Encodes the 2026-06-14 lesson: a green CI job can hide an errored/no-op model
// run, so health is judged on the result ENVELOPE, not the job conclusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunHealth, assessMesh, renderHealthReport, extractResultEnvelope, isInertDenial } from '../src/dev-mesh/health.js';

test('extractResultEnvelope: finds the result in a stream-json array, object, or wrapper', () => {
  // stream-json array (claude-code-action's saved output): pick the last result event.
  const stream = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant' },
    { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, num_turns: 1 },
  ];
  assert.equal(extractResultEnvelope(stream).is_error, true);
  // single result object
  assert.equal(extractResultEnvelope({ type: 'result', is_error: false, num_turns: 3, total_cost_usd: 0.04 }).num_turns, 3);
  // {result:{…}} wrapper
  assert.equal(extractResultEnvelope({ result: { is_error: false, num_turns: 2, total_cost_usd: 0.01 } }).num_turns, 2);
  // nothing usable
  assert.equal(extractResultEnvelope([{ type: 'system' }]), null);
  assert.equal(extractResultEnvelope(null), null);
});

test('classifyRunHealth: the real masking bug — is_error despite "success" subtype', () => {
  // The exact envelope from the first live intake run.
  const env = { type: 'result', subtype: 'success', is_error: true, duration_ms: 218, num_turns: 1, total_cost_usd: 0 };
  const h = classifyRunHealth(env);
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'errored');
});

test('classifyRunHealth: zero turns is a no-op (nothing ran)', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 0, total_cost_usd: 0 });
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'noop');
});

test('classifyRunHealth: a real working run is healthy (API-billed)', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 6, total_cost_usd: 0.12 });
  assert.equal(h.healthy, true);
  assert.equal(h.status, 'ok');
});

test('classifyRunHealth: ran-but-blocked (many permission denials) is unhealthy', () => {
  // The 2026-06-15 case: 62 turns, $1.61, is_error:false, but 25 denials and no PR.
  const h = classifyRunHealth({ is_error: false, num_turns: 62, total_cost_usd: 1.6, permission_denials_count: 25 });
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'blocked');
});

test('classifyRunHealth: a couple incidental denials are still healthy', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 8, total_cost_usd: 0.2, permission_denials_count: 1 });
  assert.equal(h.healthy, true);
});

test('classifyRunHealth: threshold boundary — 4 denials healthy, 5 blocked', () => {
  const four = classifyRunHealth({ is_error: false, num_turns: 10, total_cost_usd: 0.3, permission_denials_count: 4 });
  assert.equal(four.healthy, true);
  const five = classifyRunHealth({ is_error: false, num_turns: 10, total_cost_usd: 0.3, permission_denials_count: 5 });
  assert.equal(five.healthy, false);
  assert.equal(five.status, 'blocked');
});

test('classifyRunHealth: denials reported as an array (show_full_output form) also trip the gate', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 12, total_cost_usd: 0.4, permission_denials: new Array(7).fill({}) });
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'blocked');
});

test('isInertDenial: flags fewer-permission-prompts + .claude probes, not real denials', () => {
  assert.equal(isInertDenial({ tool_name: 'Skill', tool_input: { command: 'fewer-permission-prompts' } }), true);
  assert.equal(isInertDenial({ tool_name: 'Edit', tool_input: { file_path: '/repo/.claude/settings.json' } }), true);
  assert.equal(isInertDenial({ tool_name: 'Bash', tool_input: { command: 'cat ~/.claude/projects/x.jsonl' } }), true);
  // a real action denial (git push / gh) is NOT inert — it means a missing tool grant.
  assert.equal(isInertDenial({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }), false);
  assert.equal(isInertDenial(null), false);
  assert.equal(isInertDenial('nope'), false);
});

test('classifyRunHealth: #432 — a wall of inert fewer-permission-prompts denials stays healthy', () => {
  // The intake run that prompted #432: 8 denials, all from the model invoking the
  // /fewer-permission-prompts skill — inert on the ephemeral runner. The run did its
  // job; these must not count toward the block threshold.
  const inert = [
    { tool_name: 'Skill', tool_input: { command: 'fewer-permission-prompts' } },
    { tool_name: 'Bash', tool_input: { command: 'ls ~/.claude' } },
    { tool_name: 'Bash', tool_input: { command: 'cat .claude/settings.json' } },
    { tool_name: 'Bash', tool_input: { command: 'grep -r tool ~/.claude/projects' } },
    { tool_name: 'Edit', tool_input: { file_path: '/repo/.claude/settings.json' } },
    { tool_name: 'Write', tool_input: { file_path: '.claude/settings.json' } },
    { tool_name: 'Bash', tool_input: { command: 'cat ~/.claude/settings.json' } },
    { tool_name: 'Bash', tool_input: { command: 'head .claude/settings.local.json' } },
  ];
  const h = classifyRunHealth({ is_error: false, num_turns: 30, total_cost_usd: 0, permission_denials: inert });
  assert.equal(h.healthy, true, 'inert skill denials must not block an otherwise-healthy run');
  assert.equal(h.status, 'ok');
});

test('classifyRunHealth: real action denials still block even mixed with inert ones', () => {
  // Inert filtering must NOT mask a genuine misconfigured tool grant: 5 real git/gh
  // denials (missing Bash(git:*)) still trip the gate, regardless of inert noise.
  const denials = [
    { tool_name: 'Skill', tool_input: { command: 'fewer-permission-prompts' } }, // inert
    { tool_name: 'Bash', tool_input: { command: 'cat .claude/settings.json' } }, // inert
    ...new Array(5).fill({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }),
  ];
  const h = classifyRunHealth({ is_error: false, num_turns: 30, total_cost_usd: 0, permission_denials: denials });
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'blocked');
  assert.match(h.reason, /5 permission denials/);
});

test('classifyRunHealth: count-only form is unfilterable (no detail) — used as reported', () => {
  // A bare permission_denials_count carries no per-denial detail to identify inert
  // skills, so it can't be filtered; it stays authoritative (current behavior).
  const h = classifyRunHealth({ is_error: false, num_turns: 30, total_cost_usd: 0, permission_denials_count: 8 });
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'blocked');
});

test('classifyRunHealth: explicit zero count stays healthy (?? passes 0, not falsy-bypassed)', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 5, total_cost_usd: 0.1, permission_denials_count: 0 });
  assert.equal(h.healthy, true);
});

test('classifyRunHealth: count wins over array when both present', () => {
  // count=2 (healthy) takes precedence even though the array has 10 (would be blocked).
  const h = classifyRunHealth({ is_error: false, num_turns: 8, total_cost_usd: 0.2, permission_denials_count: 2, permission_denials: new Array(10).fill({}) });
  assert.equal(h.healthy, true);
});

test('classifyRunHealth: subscription run ($0 but real turns) is healthy, not a false no-op', () => {
  // OAuth/subscription auth always reports $0 — must NOT be flagged unhealthy.
  const h = classifyRunHealth({ is_error: false, num_turns: 3, total_cost_usd: 0 });
  assert.equal(h.healthy, true);
  assert.equal(h.status, 'ok');
  assert.match(h.reason, /subscription/);
});

test('classifyRunHealth: missing/garbage envelope is unknown (unhealthy, never throws)', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    const h = classifyRunHealth(bad);
    assert.equal(h.healthy, false);
    assert.equal(h.status, 'unknown');
  }
});

test('assessMesh: healthy only when every probe ok AND conformance clean', () => {
  const ok = { is_error: false, num_turns: 4, total_cost_usd: 0.05 };
  assert.equal(assessMesh({ runs: [{ name: 'dogfood', envelope: ok }] }).healthy, true);
  // one bad probe → unhealthy
  const bad = assessMesh({ runs: [{ name: 'dogfood', envelope: { is_error: true } }] });
  assert.equal(bad.healthy, false);
  assert.match(bad.summary, /UNHEALTHY/);
  // conformance drift alone → unhealthy even with a good probe
  const drift = assessMesh({ runs: [{ name: 'dogfood', envelope: ok }], conformanceFlags: ['maintainer registry drifted'] });
  assert.equal(drift.healthy, false);
});

test('renderHealthReport: emits a Markdown table and flags section', () => {
  const a = assessMesh({
    runs: [{ name: 'dogfood', envelope: { is_error: true, duration_ms: 218, num_turns: 1, total_cost_usd: 0 } }],
    conformanceFlags: ['coder .mcp.json missing peer bridge'],
  });
  const md = renderHealthReport(a);
  assert.match(md, /Dev-mesh health: 🔴 unhealthy/);
  assert.match(md, /\| dogfood \| 🔴 errored \|/);
  assert.match(md, /coder \.mcp\.json missing peer bridge/);
});

test('renderHealthReport: a blocked probe renders its row', () => {
  const a = assessMesh({ runs: [{ name: 'backlog', envelope: { is_error: false, num_turns: 62, total_cost_usd: 1.6, permission_denials_count: 25 } }] });
  assert.match(renderHealthReport(a), /\| backlog \| 🔴 blocked \|/);
});
