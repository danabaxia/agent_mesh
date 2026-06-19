import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('daemon wires the mesh-level heartbeat loop', () => {
  assert.match(daemon, /runHeartbeat/, 'imports/uses runHeartbeat');
  assert.match(daemon, /AGENT_MESH_HEARTBEAT_FILE|heartbeat\.json/, 'has a heartbeat snapshot path');
  assert.match(daemon, /HEARTBEAT_INTERVAL_MS|DEFAULT_HEARTBEAT_INTERVAL_MS/, 'uses the interval');
  assert.match(daemon, /setInterval\(\s*heartbeatTick|heartbeatTimer\s*=\s*setInterval/s, 'starts a heartbeat interval');
  assert.match(daemon, /clearInterval\(\s*heartbeatTimer\s*\)/, 'clears the heartbeat on shutdown');
});
