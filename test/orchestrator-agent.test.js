import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon registers the gh-activity-poll builtin with the scheduler', () => {
  assert.match(daemon, /pollGhActivity/, 'imports/uses pollGhActivity');
  assert.match(daemon, /'gh-activity-poll'/, 'registers the gh-activity-poll builtin');
  assert.match(daemon, /createScheduler\([^)]*builtins/s, 'passes builtins to createScheduler');
  assert.match(daemon, /AGENT_MESH_GH_ACTIVITY|gh-activity\.json/, 'has a gh-activity cache path');
});

const repo = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8');

test('orchestrator agent is registered in dev-mesh with the gh-activity-poll builtin', () => {
  const mesh = JSON.parse(repo('dev-mesh/mesh.json'));
  const orch = (mesh.agents || []).find((a) => a.name === 'orchestrator');
  assert.ok(orch, 'orchestrator present in mesh.json');
  assert.equal(orch.served, true);
  const sched = JSON.parse(repo('dev-mesh/orchestrator/.agent/schedule.json'));
  const job = (sched.jobs || []).find((j) => j.builtin === 'gh-activity-poll');
  assert.ok(job, 'gh-activity-poll job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.cadence.kind, 'every');
});
