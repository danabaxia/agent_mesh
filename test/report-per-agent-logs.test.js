// test/report-per-agent-logs.test.js — the daily-report token panel reads run
// logs from EVERY served agent's own .agent-mesh/logs dir, not a single mesh-wide
// path. Regression for the "token panel shows zero" bug: AGENT_MESH_LOG_DIR
// resolves under each served agent root, so delegate-<date>.jsonl lives per-agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentLogDirs, readLocalLogsMulti } from '../src/report/sources.js';
import { extractUsage, sumUsage } from '../src/report/usage.js';

const DATE = '2026-06-21';

// One delegation = a start line (no usage) then a done line (usage), SAME id —
// mirrors the real run log, where naive first-wins dedup would drop the usage.
function runLines(id, costUsd) {
  return [
    JSON.stringify({ id, route: 'x', state: 'running' }),
    JSON.stringify({ id, route: 'x', state: 'done', usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: costUsd, num_turns: 1 } }),
  ].join('\n') + '\n';
}

async function meshWithAgents(agents) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'rep-mesh-'));
  for (const [name, lines] of Object.entries(agents)) {
    const dir = join(meshRoot, name, '.agent-mesh', 'logs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `delegate-${DATE}.jsonl`), lines);
  }
  return meshRoot;
}

test('agentLogDirs enumerates one log dir per agent subfolder', async () => {
  const meshRoot = await meshWithAgents({ analyst: runLines('a', 1), tester: runLines('b', 1) });
  const dirs = agentLogDirs({ meshRoot });
  assert.ok(dirs.includes(join(meshRoot, 'analyst', '.agent-mesh', 'logs')));
  assert.ok(dirs.includes(join(meshRoot, 'tester', '.agent-mesh', 'logs')));
});

test('agentLogDirs skips dot-named agent dirs and includes extraDirs (legacy top-level)', async () => {
  const meshRoot = await meshWithAgents({ analyst: runLines('a', 1) });
  await mkdir(join(meshRoot, '.git', 'objects'), { recursive: true }); // dot-dir must not be treated as an agent
  const legacy = '/tmp/legacy/.agent-mesh/logs';
  const dirs = agentLogDirs({ meshRoot, extraDirs: [legacy] });
  assert.ok(dirs.includes(legacy));
  assert.ok(dirs.includes(join(meshRoot, 'analyst', '.agent-mesh', 'logs')));
  assert.ok(!dirs.some((d) => d.startsWith(join(meshRoot, '.git'))), 'dot-named agent dir skipped');
});

test('agentLogDirs on a missing mesh root returns just the extras (no throw)', () => {
  const dirs = agentLogDirs({ meshRoot: '/no/such/mesh', extraDirs: ['/x/logs'] });
  assert.deepEqual(dirs, ['/x/logs']);
});

test('readLocalLogsMulti aggregates usage across agents and dedups start/done by id', async () => {
  const meshRoot = await meshWithAgents({
    analyst: runLines('a1', 0.50) + runLines('a2', 0.25),
    tester: runLines('t1', 1.00),
  });
  const records = await readLocalLogsMulti({ logDirs: agentLogDirs({ meshRoot }), date: DATE });
  assert.equal(records.length, 3, 'three distinct runs across two agents (start/done merged)');
  const total = sumUsage(records.map(extractUsage));
  assert.equal(Number(total.costUsd.toFixed(2)), 1.75, 'costs summed across agents, not zeroed');
  assert.equal(total.output, 60); // 3 runs × 20
});

test('readLocalLogsMulti tolerates dirs with no log file for the date', async () => {
  const meshRoot = await meshWithAgents({ analyst: runLines('a', 0.40) });
  const dirs = [...agentLogDirs({ meshRoot }), join(meshRoot, 'absent', '.agent-mesh', 'logs')];
  const records = await readLocalLogsMulti({ logDirs: dirs, date: DATE });
  assert.equal(records.length, 1);
});
