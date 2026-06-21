import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectHealth } from '../src/dashboard/health-collect.js';

// Build a minimal mesh: <meshRoot>/mesh.json + agent folders, with a sibling
// .dev-society/ for the heartbeat snapshot + activity log.
async function makeMesh(t, agents = [{ name: 'alpha', root: './alpha' }]) {
  const base = await mkdtemp(join(tmpdir(), 'health-collect-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }));
  const meshRoot = join(base, 'mesh');
  await mkdir(meshRoot, { recursive: true });
  await mkdir(join(base, '.dev-society'), { recursive: true });
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: '0.1.0',
    agents: agents.map((a) => ({ name: a.name, root: a.root, card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] })),
  }));
  for (const a of agents) await mkdir(join(meshRoot, a.root), { recursive: true });
  return { base, meshRoot, society: join(base, '.dev-society') };
}

const logLine = (r) => JSON.stringify(r) + '\n';

test('empty mesh → valid nominal report, never throws', async (t) => {
  const { meshRoot } = await makeMesh(t);
  const m = await collectHealth({ meshRoot, env: {}, now: new Date('2026-06-21T12:00:00Z') });
  assert.equal(m.overall, 'nominal');
  assert.equal(m.agentVitals.length, 1);
  assert.equal(m.agentVitals[0].name, 'alpha');
});

test('reads run logs into activity history + liveness', async (t) => {
  const now = new Date('2026-06-21T12:00:00Z');
  const { meshRoot } = await makeMesh(t);
  const logDir = join(meshRoot, 'alpha', '.agent-mesh', 'logs');
  await mkdir(logDir, { recursive: true });
  const ts = new Date(now.getTime() - 5 * 60_000).toISOString();
  await writeFile(join(logDir, `delegate-2026-06-21.jsonl`),
    logLine({ id: 'r1', state: 'started', started_at: ts }) +
    logLine({ id: 'r1', state: 'done', started_at: ts, finished_at: ts, status: 'done' }));
  const m = await collectHealth({ meshRoot, env: {}, now });
  assert.equal(m.agentVitals[0].liveness, 'alive');
  assert.equal(m.agentVitals[0].recentRuns, 1);
});

test('reads heartbeat snapshot + daemon freshness, tolerates corrupt activity', async (t) => {
  const now = new Date('2026-06-21T12:00:00Z');
  const { meshRoot, society } = await makeMesh(t);
  await writeFile(join(society, 'heartbeat.json'), JSON.stringify({
    generatedAt: new Date(now.getTime() - 60_000).toISOString(),
    summary: { ok: 1, failing: 1, overdue: 0, stuck: 0, escalated: 0 },
    findings: [{ agent: 'alpha', jobId: 'nightly', condition: 'failing', severity: 'warn', since: now.toISOString() }],
    openEscalations: [],
  }));
  await writeFile(join(society, 'daemon.log'), 'tick\n');
  await writeFile(join(society, 'activity-2026-06-21.jsonl'), '{ not json\n');  // corrupt → tolerated
  const m = await collectHealth({ meshRoot, env: {}, now });
  assert.equal(m.organs.jobs.summary.failing, 1);
  assert.equal(m.organs.jobs.daemonAlive, true);
  assert.equal(m.agentVitals[0].liveness, 'failing');
  // backward-compat keys preserved for the existing Graph-view panel
  assert.equal(m.findings.length, 1);
});

test('cognition byte sizes: prompt + memory long/short split', async (t) => {
  const { meshRoot } = await makeMesh(t);
  const agentDir = join(meshRoot, 'alpha');
  await writeFile(join(agentDir, 'AGENT.md'), 'x'.repeat(20_000));   // oversize prompt
  await mkdir(join(agentDir, 'memory'), { recursive: true });
  await writeFile(join(agentDir, 'memory', 'quick.json'), '{}');     // short-term present
  // no learned.md/decisions.md → long-term absent → no_memory_separation flag
  const m = await collectHealth({ meshRoot, env: {}, now: new Date('2026-06-21T12:00:00Z') });
  const cog = m.agentVitals[0].cognition;
  assert.ok(cog.promptBytes >= 20_000);
  assert.ok(cog.memoryShortBytes > 0);
  assert.equal(cog.memoryLongBytes, 0);
  assert.ok(cog.flags.includes('prompt_oversize'));
  assert.ok(cog.flags.includes('no_memory_separation'));
  assert.equal(m.organs.cognition.status, 'warn');
});
