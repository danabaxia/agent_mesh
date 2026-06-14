// Opt-in real-`claude` end-to-end: Agent B (the library) receives an A2A
// message, spawns its worker with its prompts/ identity, calls its own
// book-search MCP tool, and returns the answer in the Task.
//
// SKIPPED by default. Enable:
//   AGENT_MESH_E2E=1 npm test
// Requires `claude` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createA2AClient } from '../src/a2a/stdio-client.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentB = join(repoRoot, 'examples', 'agent-b');
const bin = join(repoRoot, 'bin', 'agent-mesh.js');

function claudeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const skip =
  process.env.AGENT_MESH_E2E !== '1'
    ? 'set AGENT_MESH_E2E=1 to run the real-claude E2E'
    : !claudeAvailable()
      ? 'claude not on PATH'
      : false;

test('Agent B answers a book lookup over A2A using its own tool', { skip, timeout: 600_000 }, async () => {
  const client = await createA2AClient({
    library: { root: agentB, command: 'node', args: [bin, 'serve-a2a', agentB] }
  });

  try {
    const task = await client.send('library', {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: "Do you have 'Dune'? Which shelf?" }],
      metadata: { 'agentmesh/mode': 'ask' }
    });

    assert.equal('kind' in task, false, 'v1.0 Task has no kind discriminator');
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    const answer = task.status.message.parts.map((p) => p.text || '').join('\n');
    assert.match(answer, /Dune/i);
    assert.match(answer, /shelf\s*3/i);
  } finally {
    await client.close();
  }
});
