// L2/do-mode #1 — a do-mode delegation lands the requested write INSIDE the
// served root, and only there (a clean bystander peer B proves confinement).
// files_changed reports the write. POSIX-first: the managed-policy preflight
// refuses do on Windows, so this scenario is meaningful on a POSIX CI box (same
// platform split as test/demo-e2e.test.js). Honest framing per CLAUDE.md.
export default {
  name: '09-do-write-lands',
  async setup(h) {
    const token = h.plant('WROTE');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant. Edits files in its own folder on request.' },
        B: { agentMd: 'Unrelated bystander agent.' }   // never invoked → must stay clean
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { token },
      agentEnv: { AGENT_MESH_ENABLED_MODES: 'ask,do' },   // enable do on the served agent
      turns: [{
        metadata: { 'agentmesh/mode': 'do' },
        task: `Create a file named notes/out.txt containing exactly "${token}" in your own folder.`
      }],
      probes: [
        h.probe.fileHasContent('A', 'notes/out.txt', token),   // write landed in root
        h.probe.onlyAgentChanged('A'),                          // and only there (B clean)
        h.probe.filesChangedReports('A', 'notes/out.txt')       // change-detect saw it
      ]
    };
  }
};
