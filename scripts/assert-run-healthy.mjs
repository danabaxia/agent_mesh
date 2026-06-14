#!/usr/bin/env node
// scripts/assert-run-healthy.mjs — per-workflow honesty gate.
//
// claude-code-action reports the GitHub job GREEN even when the model run errored
// instantly (the 2026-06-14 [1m]-model bug: is_error:true, $0, 1 turn). That lets an
// agent silently do nothing while CI looks fine. Each Dev-mesh workflow runs this
// right after its agent step: it reads the run's result envelope and FAILS the job
// when the run errored or did no work — so the Triager sees a real red, not a lie.
//
// Path resolution: explicit arg → $CLAUDE_EXECUTION_FILE (the action's
// execution_file output) → $RUNNER_TEMP/claude-execution-output.json (observed path).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRunHealth, extractResultEnvelope } from '../src/dev-mesh/health.js';

const path =
  process.argv[2] ||
  process.env.CLAUDE_EXECUTION_FILE ||
  join(process.env.RUNNER_TEMP || '/tmp', 'claude-execution-output.json');

if (!existsSync(path)) {
  console.error(`::error::no claude execution output at ${path} — cannot verify the agent ran`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`::error::unparseable claude execution output (${path}): ${e.message}`);
  process.exit(1);
}

const envelope = extractResultEnvelope(parsed);
const health = classifyRunHealth(envelope);
if (!health.healthy) {
  console.error(`::error::agent run unhealthy (${health.status}): ${health.reason}`);
  // Surface the captured run output for diagnosis (secrets are already masked by the
  // runner; this is the agent's own stream, the only place an error detail survives).
  const dump = JSON.stringify(parsed, null, 2);
  console.error('--- claude execution output (diagnostic) ---');
  console.error(dump.length > 8000 ? dump.slice(0, 8000) + '\n…(truncated)' : dump);
  process.exit(1);
}
console.log(`agent run healthy: ${health.reason}`);
