/**
 * test/reserved-env.test.js
 *
 * Regression for the reserved-env protection (codex R1/BLOCKER-2): a registry
 * `peer.env` must NOT be able to override the keys the bridge marks protected
 * (AGENT_MESH_MODE / MESH_ROOT / MESH_CEILING, plus the built-in PATH/DEPTH).
 * Previously `peerEnv` ignored the passed `protectedEnv`, so the override slipped
 * through — this test pins the fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createA2AClient } from '../src/a2a/stdio-client.js';

// A fake peer: on spawn it records the security-relevant env it was given, then
// answers the first JSON-RPC request so client.send() resolves cleanly.
async function fakePeer(capturePath) {
  const dir = await mkdtemp(join(tmpdir(), 'reserved-env-'));
  const script = join(dir, 'peer.mjs');
  await writeFile(
    script,
    `import fs from 'node:fs';
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({
  mode: process.env.AGENT_MESH_MODE ?? null,
  ceiling: process.env.AGENT_MESH_MESH_CEILING ?? null,
  meshRoot: process.env.AGENT_MESH_MESH_ROOT ?? null,
  passthrough: process.env.TOOL_API_KEY ?? null
}));
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { task: { status: { state: 'TASK_STATE_COMPLETED' } } } }) + '\\n');
  }
});
`,
    'utf8'
  );
  await chmod(script, 0o755);
  return script;
}

test('registry peer.env cannot override reserved keys; non-reserved keys pass through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reserved-env-cap-'));
  const capture = join(dir, 'capture.json');
  const script = await fakePeer(capture);

  const registry = {
    peers: {
      lib: {
        root: dir,
        command: 'node',
        args: [script],
        // operator-authored env attempting to escalate / redirect:
        env: {
          AGENT_MESH_MODE: 'do',          // try to escalate to write
          AGENT_MESH_MESH_CEILING: '/evil',
          AGENT_MESH_MESH_ROOT: '/evil/mesh',
          TOOL_API_KEY: 'sk-123'          // non-reserved → should pass through
        }
      }
    }
  };

  const client = await createA2AClient(registry, {
    env: {
      ...process.env,
      CAPTURE: capture,
      AGENT_MESH_MODE: 'ask',             // authoritative base values
      AGENT_MESH_MESH_CEILING: '/real',
      AGENT_MESH_MESH_ROOT: '/real/mesh'
    },
    protectedEnv: ['AGENT_MESH_MODE', 'AGENT_MESH_MESH_ROOT', 'AGENT_MESH_MESH_CEILING'],
    requestTimeoutMs: 5000
  });

  try {
    await client.send('lib', {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'hi' }],
      metadata: { 'agentmesh/mode': 'ask' }
    });
  } catch { /* peer may exit after replying; we only need the captured env */ } finally {
    await client.close().catch(() => {});
  }

  const seen = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(seen.mode, 'ask', 'reserved AGENT_MESH_MODE must come from base, not peer.env');
  assert.equal(seen.ceiling, '/real', 'reserved MESH_CEILING must come from base');
  assert.equal(seen.meshRoot, '/real/mesh', 'reserved MESH_ROOT must come from base');
  assert.equal(seen.passthrough, 'sk-123', 'non-reserved peer.env keys still pass through');
});
