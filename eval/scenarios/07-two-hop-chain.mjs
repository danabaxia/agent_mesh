// Scenario 7 — onward chain A→B→C: the fact lives only in C; B's registry
// lists C; the parent_run_id chain proves both hops (spec §4 #7).
// The task's 'Your peer network can help' nudge is BY DESIGN: this scenario
// measures two-hop wiring (depth budget, parent_run_id chain), not unprompted
// delegation choice — that is scenario 01's job.
export default {
  name: '07-two-hop-chain',
  async setup(h) {
    const fact = h.plant('ARCHIVE');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['B'] },
        B: {
          agentMd: 'Records front-desk agent. For archive lookups it consults its own archive peer.',
          peers: ['C']
        },
        C: {
          agentMd: 'Archive vault agent. Owns the canonical archive codes in data/archive.md.',
          files: { 'data/archive.md': `Ledger 1907 archive code: ${fact}\n` }
        }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'Find the archive code for ledger 1907. Your peer network can help. Reply with the exact code.' }],
      probes: [
        h.probe.peerRan('B'),
        h.probe.peerRanUnder('C', 'B'),
        h.probe.answerContains(0, fact),
        h.probe.peersClean(['A', 'B', 'C'])
      ]
    };
  }
};
