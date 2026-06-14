// Perf cell — 12 peers, confusable domains. The degradation tail: does routing
// precision collapse as confusable peers are added? This cell vs the 6-peer cell
// IS the agent-performance curve.
export default {
  name: '03-routing-confusable-12',
  cell: { peers: 12, overlap: 'confusable' },
  async setup(h) {
    const mesh = await h.buildRoutingMesh({ peers: 12, overlap: 'confusable', claude: h.claudeBin });
    return { mesh, driven: 'A', tasks: h.routingTasks(mesh, { count: 4 }),
      meters: [h.meters.routing(), h.meters.efficiency(), h.meters.quality()] };
  }
};
