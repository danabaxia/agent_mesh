import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createA2AClient } from '../src/a2a/stdio-client.js';

test('A2A client spawns a registry peer and sends SendMessage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-a2a-peer-'));
  const canonicalRoot = await realpath(root);
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const fakeClaude = join(root, 'fake-claude.mjs');
  await writeFile(fakeClaude, "#!/usr/bin/env node\nconsole.log('peer completed task');\n");
  await chmod(fakeClaude, 0o755);

  const client = await createA2AClient({
    knowledge: {
      root: canonicalRoot,
      command: process.execPath,
      args: [resolve('bin/agent-mesh.js'), 'serve-a2a', canonicalRoot],
      env: { AGENT_MESH_CLAUDE: fakeClaude }
    }
  });

  try {
    const initialized = await client.initialize('knowledge');
    assert.equal(initialized.agentCard['x-agentmesh'].root, canonicalRoot);

    const task = await client.send('knowledge', {
      messageId: 'm1',
      role: 'ROLE_USER',
      parts: [{ text: 'answer from peer' }],
      metadata: { 'agentmesh/mode': 'ask' }
    });

    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.match(task.artifacts[0].parts[0].text, /peer completed task/);
    assert.equal(typeof task.metadata['agentmesh/metrics'].total_ms, 'number');
  } finally {
    await client.close();
  }
});
