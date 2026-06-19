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
