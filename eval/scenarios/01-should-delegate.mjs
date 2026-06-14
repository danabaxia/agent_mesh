// Scenario 1 — A must delegate: the fact exists ONLY in peer B (spec §4 #1).
export default {
  name: '01-should-delegate',
  async setup(h) {
    const fact = h.plant('SHELF');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent for this workspace.', peers: ['B'] },
        B: {
          agentMd: 'Library catalog agent. Capabilities: catalog lookup, shelf locations. ' +
                   'Owns the canonical shelf-code records for the catalog.',
          files: { 'data/shelf-codes.md': `The Dune Atlas: ${fact}\n` }
        }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'Find the current shelf code for the book "The Dune Atlas". Reply with the exact code.' }],
      probes: [h.probe.peerRan('B'), h.probe.answerContains(0, fact), h.probe.peersClean(['A', 'B'])]
    };
  }
};
