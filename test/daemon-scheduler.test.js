// test/daemon-scheduler.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon wires the standard scheduler from src/schedule, runs it 24/7', () => {
  assert.match(src, /from '\.\.\/src\/schedule\/scheduler\.js'/, 'imports createScheduler from src/schedule');
  assert.match(src, /createScheduler\(/, 'creates a scheduler');
  assert.match(src, /DEV_SOCIETY_MESH_ROOT/, 'mesh root is configurable');
  assert.match(src, /\.start\(\)/, 'starts the scheduler');
  assert.match(src, /\.stop\(\)/, 'stops the scheduler on shutdown');
});
