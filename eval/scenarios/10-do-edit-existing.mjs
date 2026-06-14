// L2/do-mode #2 — a do-mode delegation EDITS an existing tracked file: the old
// value is replaced by the planted token in place, only the served folder
// changes. Exercises the Edit/MultiEdit write path (not just Write).
export default {
  name: '10-do-edit-existing',
  async setup(h) {
    const token = h.plant('NEWVAL');
    const old = h.plant('OLDVAL');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant. Edits files in its own folder on request.',
             files: { 'data.txt': `value=${old}\n` } }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { token, old },
      agentEnv: { AGENT_MESH_ENABLED_MODES: 'ask,do' },
      turns: [{
        metadata: { 'agentmesh/mode': 'do' },
        task: `In data.txt, replace "${old}" with "${token}". Change nothing else.`
      }],
      probes: [
        h.probe.fileHasContent('A', 'data.txt', token),         // new value present
        h.probe.onlyAgentChanged('A'),
        // old value gone (inline gate — no helper covers absence-of-substring).
        { name: 'old-value-gone', async check(ctx) {
            const { readFile } = await import('node:fs/promises');
            const { join } = await import('node:path');
            let text = '';
            try { text = await readFile(join(ctx.mesh.agents.A.root, 'data.txt'), 'utf8'); } catch {}
            return { pass: !text.includes(old), detail: text.slice(0, 120) };
        } }
      ]
    };
  }
};
