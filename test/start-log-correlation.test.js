/**
 * test/start-log-correlation.test.js
 *
 * Inc A — the start-log + run-correlation foundation that the dynamic board and
 * orchestration specs build on:
 *  - a START log (state:"started", no finished_at) exists DURING the run;
 *  - it is finalized (state:"done") with id / parent_run_id / route;
 *  - the framework log dir is excluded from change detection (no files_changed
 *    pollution, no spurious preexisting_dirty).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { delegateTask } from '../src/delegate.js';
import { readRunLogRecords } from '../src/log.js';

const execFileAsync = promisify(execFile);

async function gitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'startlog-'));
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
  return root;
}

// Fake claude: while running, it reads the newest run log in this root's log dir
// and records that log's state+id (proving the START log exists mid-run), then
// writes capture.json (a real change) so files_changed can be asserted.
async function fakeClaude() {
  const dir = await mkdtemp(join(tmpdir(), 'startlog-fake-'));
  const path = join(dir, 'fake.mjs');
  await writeFile(
    path,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const logDir = path.join(process.env.AGENT_MESH_ROOT, '.agent-mesh', 'logs');
let start = null;
try {
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
  const newest = files.sort().at(-1);
  // grouped NDJSON — the first line is the START record for this run.
  const first = fs.readFileSync(path.join(logDir, newest), 'utf8').split('\\n').filter(Boolean)[0];
  start = JSON.parse(first);
} catch {}
fs.writeFileSync(path.join(process.env.AGENT_MESH_ROOT, 'capture.json'),
  JSON.stringify({ startState: start?.state ?? null, startId: start?.id ?? null,
                   runIdEnv: process.env.AGENT_MESH_RUN_ID ?? null }));
console.log('ok');
`,
    'utf8'
  );
  await chmod(path, 0o755);
  return path;
}

test('start log exists mid-run, finalizes with id/parent/route, excluded from change-detect', async () => {
  const root = await gitRepo();
  const claude = await fakeClaude();

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: claude, CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'ask', task: 'find dune' },
    parentRunId: 'parent-123',
    route: 'agent'
  });

  assert.equal(result.status, 'done');

  // (1) The START log existed while the worker ran.
  const cap = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  assert.equal(cap.startState, 'started', 'a state:"started" log must exist during the run');
  assert.ok(cap.startId, 'start log carries an id');
  assert.equal(cap.runIdEnv, cap.startId, 'AGENT_MESH_RUN_ID matches the run id');

  // (2) The grouped per-date log finalized with correlation fields.
  const logDir = join(root, '.agent-mesh', 'logs');
  const logs = (await readdir(logDir)).filter((f) => f.endsWith('.jsonl'));
  assert.equal(logs.length, 1, 'one grouped per-date file');
  const recs = await readRunLogRecords(join(logDir, logs[0]));
  assert.equal(recs.length, 2, 'a start record and a final record');
  const finalLog = recs.find((r) => r.state === 'done');
  assert.equal(finalLog.state, 'done');
  assert.equal(finalLog.id, cap.startId);
  assert.equal(finalLog.parent_run_id, 'parent-123');
  assert.equal(finalLog.route, 'agent');
  assert.ok(finalLog.finished_at, 'finalized log has finished_at');

  // (3) Change detection excludes the framework log dir.
  assert.deepEqual(result.files_changed, ['capture.json'], 'run logs must not appear in files_changed');
  assert.equal(result.preexisting_dirty, undefined, 'the start log must not flip preexisting_dirty');
});

test('parent_run_id defaults to null when not provided', async () => {
  const root = await gitRepo();
  const claude = await fakeClaude();
  await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: claude },
    input: { mode: 'ask', task: 'x' }
  });
  const logDir = join(root, '.agent-mesh', 'logs');
  const logs = (await readdir(logDir)).filter((f) => f.endsWith('.jsonl'));
  const recs = await readRunLogRecords(join(logDir, logs[0]));
  const log = recs.find((r) => r.state === 'done');
  assert.equal(log.parent_run_id, null);
  assert.equal(log.route, null);
});
