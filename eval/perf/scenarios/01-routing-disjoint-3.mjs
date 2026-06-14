// Perf cell — 3 peers, disjoint domains. The easy baseline: routing should be
// near-perfect, so this anchors the precision/recall curve's high end.
export default {
  name: '01-routing-disjoint-3',
  cell: { peers: 3, overlap: 'disjoint' },
  async setup(h) {
    const mesh = await h.buildRoutingMesh({ peers: 3, overlap: 'disjoint', claude: h.claudeBin });
    return { mesh, driven: 'A', tasks: h.routingTasks(mesh, { count: 3 }),
      meters: [h.meters.routing(), h.meters.efficiency(), h.meters.quality()] };
  }
};
