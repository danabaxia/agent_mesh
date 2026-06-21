import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCadence } from '../src/schedule/schedule-cadence.js';

const p = (rel) => fileURLToPath(new URL(`../dev-mesh/tester/${rel}`, import.meta.url));

test('tester schedule.json has a valid tester-suite-run builtin job', () => {
  const sched = JSON.parse(readFileSync(p('.agent/schedule.json'), 'utf8'));
  const job = sched.jobs.find((j) => j.id === 'tester-suite-run');
  assert.ok(job, 'tester-suite-run job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.builtin, 'tester-suite-run');
  assert.equal(validateCadence(job.cadence).ok, true);
});

test('tester stays ask-only and is wired no mutating MCP server', () => {
  const mesh = JSON.parse(readFileSync(fileURLToPath(new URL('../dev-mesh/mesh.json', import.meta.url)), 'utf8'));
  const tester = mesh.agents.find((a) => a.name === 'tester');
  assert.deepEqual(tester.enabledModes, ['ask']);
  // The tester is a board participant (analyst/coder list it as a peer), so `doctor` wires
  // the ask-safe onward-delegation peer-bridge into its .mcp.json. That is NOT a mutating
  // server: `delegate_to_peer` is ask-only, and `create_task_for_peer` writes only the
  // framework-owned board (never a peer's folder). The real invariant is "no MUTATING MCP
  // server" — so IF a .mcp.json exists it must contain ONLY the ask-safe peer-bridge. Issue
  // mutation stays host-side (the daemon). (CI's clean clone has no .mcp.json → vacuous.)
  const mcpPath = p('.mcp.json');
  if (existsSync(mcpPath)) {
    const servers = Object.keys(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers ?? {});
    assert.deepEqual(servers, ['agentmesh_peerbridge'],
      `tester .mcp.json must carry ONLY the ask-safe peer-bridge (no mutating server); got ${JSON.stringify(servers)}`);
  }
});
