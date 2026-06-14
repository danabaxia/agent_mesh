// Scenario 2 — A must NOT delegate: the fact is in A's OWN folder (spec §4 #2).
export default {
  name: '02-should-not-delegate',
  async setup(h) {
    const fact = h.plant('LOCAL');
    const mesh = await h.buildMesh({
      agents: {
        A: {
          agentMd: 'Workspace assistant. Keeps its own project notes in notes/.',
          files: { 'notes/build-id.md': `Current build id: ${fact}\n` },
          peers: ['B']
        },
        B: { agentMd: 'Weather agent. Capabilities: forecasts only. Knows nothing about this workspace.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'What is the current build id recorded in this project\'s notes? Reply with the exact id.' }],
      probes: [h.probe.noPeerRan(['B']), h.probe.answerContains(0, fact), h.probe.peersClean(['A', 'B'])]
    };
  }
};
