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
  // No mutating MCP config is added to the tester folder (issue mutation is host-side).
  assert.equal(existsSync(p('.mcp.json')), false);
});
