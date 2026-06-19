import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon wires the activity log', () => {
  assert.match(daemon, /recordActivity/, 'imports/uses recordActivity');
  assert.match(daemon, /pruneActivity/, 'wires the prune');
  assert.match(daemon, /onJobResult/, 'passes onJobResult to the scheduler');
  assert.match(daemon, /AGENT_MESH_ACTIVITY_DIR|activity-log/, 'has an activity dir');
});
