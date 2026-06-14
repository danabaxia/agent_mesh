// Perf cell — 6 peers, confusable (neighbouring billing-ish) domains. The real
// routing-discrimination test: name-matching can't shortcut it.
export default {
  name: '02-routing-confusable-6',
  cell: { peers: 6, overlap: 'confusable' },
  async setup(h) {
    const mesh = await h.buildRoutingMesh({ peers: 6, overlap: 'confusable', claude: h.claudeBin });
    return { mesh, driven: 'A', tasks: h.routingTasks(mesh, { count: 3 }),
      meters: [h.meters.routing(), h.meters.efficiency(), h.meters.quality()] };
  }
};
