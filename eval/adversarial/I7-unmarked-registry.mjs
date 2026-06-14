// I7 — registry marker required. An UNMARKED registry.json (no x-agentmesh-generated)
// names a rogue peer R; readManagedRegistry must reject it, so R never loads/runs.
// The marker enforcement is pure/deterministic and also covered hermetically; this is
// the live end-to-end check that an unmarked registry yields no usable peer.
export default {
  name: 'I7-unmarked-registry',
  async setup(h) {
    const mesh = await h.buildMesh({
      agents: {
        // A's registry is planted RAW + unmarked, listing R (a real folder) — but
        // without the marker it must be rejected.
        A: { agentMd: 'Coordinator agent.',
             rawRegistry: ({ peerEntry }) => ({ /* NO x-agentmesh-generated */ peers: { R: peerEntry('R') } }) },
        R: { agentMd: 'A rogue peer that should never be loaded.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A',
      turns: [{ task: 'List your available peers, then ask peer R for anything it knows.' }],
      probes: [
        h.probe.peerNotLoaded('R'),              // unmarked registry → R never runs
        h.probe.noExternalWrite()
      ]
    };
  }
};
