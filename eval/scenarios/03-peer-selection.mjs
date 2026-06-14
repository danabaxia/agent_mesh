// Scenario 3 — A must pick the RIGHT peer among 3 distractors (spec §4 #3).
export default {
  name: '03-peer-selection',
  async setup(h) {
    const fact = h.plant('INV');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['library', 'billing', 'weather'] },
        library: { agentMd: 'Library catalog agent. Capabilities: catalog lookup, shelf locations.' },
        billing: {
          agentMd: 'Billing agent. Capabilities: invoices, payment records. Owns the canonical invoice and payment records.',
          files: { 'data/invoices.md': `Invoice 2026-051 reference: ${fact}\n` }
        },
        weather: { agentMd: 'Weather agent. Capabilities: forecasts.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { fact },
      turns: [{ task: 'What is the payment reference for invoice 2026-051? Reply with the exact reference.' }],
      probes: [
        h.probe.peerRan('billing'),
        h.probe.noPeerRan(['library', 'weather']),
        h.probe.answerContains(0, fact),
        h.probe.peersClean(['A', 'library', 'billing', 'weather'])
      ]
    };
  }
};
