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
//
// Flag --advisory-blocked: scope the 'blocked' (>= denial threshold) → advisory rule
// to ONLY the light comment/ask roles (review/triage/intake/research) that aren't
// granted git/general shell, so probing a denied command is expected noise there.
// Without the flag (the default — every do-mode pusher: autofix/mergefix/backlog/
// curate) 'blocked' stays FATAL: for those, >= 5 denials means a real misconfigured
// tool grant (the original 2026-06-15 Bash(git) vs git:* bug the gate exists to catch).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { buildUsageRecord } from '../src/report/usage-record.js';
import { join } from 'node:path';
import { classifyRunHealth, extractResultEnvelope } from '../src/dev-mesh/health.js';

const args = process.argv.slice(2);
const advisoryBlocked = args.includes('--advisory-blocked');
const path =
  args.find((a) => !a.startsWith('--')) ||
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
// Capture token usage for the daily report. Best-effort: a failure here must
// NEVER change the health gate's verdict (the run still consumed the tokens).
if (process.env.MESH_USAGE_OUT) {
  try {
    writeFileSync(process.env.MESH_USAGE_OUT, JSON.stringify(buildUsageRecord(envelope, process.env)));
  } catch (e) {
    console.warn(`::warning::usage capture failed (non-fatal): ${e.message}`);
  }
}
const health = classifyRunHealth(envelope);

// errored/noop/unknown are always fatal (a run that errored, did nothing, or wrote
// unreadable output). 'blocked' (>= denial threshold) is fatal ONLY in the strict
// default; with --advisory-blocked it's downgraded to a warning for the light comment/
// ask roles, where an agent granted just Read/Grep/Glob/Bash(gh:*) naturally probes
// ungranted shell (ls/cat/git diff) while still doing real work — those denials don't
// mean the run failed, and the hard-fail turned the advisory review check RED on every PR.
const FATAL = new Set(['errored', 'noop', 'unknown']);
if (!advisoryBlocked) FATAL.add('blocked');
if (!health.healthy && FATAL.has(health.status)) {
  console.error(`::error::agent run unhealthy (${health.status}): ${health.reason}`);
  // Surface the captured run output for diagnosis (secrets are already masked by the
  // runner; this is the agent's own stream, the only place an error detail survives).
  const dump = JSON.stringify(parsed, null, 2);
  console.error('--- claude execution output (diagnostic) ---');
  console.error(dump.length > 8000 ? dump.slice(0, 8000) + '\n…(truncated)' : dump);
  process.exit(1);
}
if (!health.healthy) {
  console.warn(`::warning::agent run advisory (${health.status}): ${health.reason}`);
} else {
  console.log(`agent run healthy: ${health.reason}`);
}
