// eval/perf/harness.mjs — scale fixture generator for the perf benchmark (spec §5).
// Rides the behavior-eval harness (buildMesh/driveAgent/readRuns/cleanupMesh/plant);
// adds buildRoutingMesh, which materializes a caller A wired to N specialist peers
// with domain-shaped AGENT.mds + a random planted fact each. Overlap is the
// discrimination knob: `disjoint` (orthogonal domains) vs `confusable` (neighbours a
// weak router conflates). Returns the mesh plus the planted domains so a scenario can
// build ground-truth-labelled tasks.
import { buildMesh, driveAgent, readRuns, gitClean, cleanupMesh, plant } from '../harness.mjs';

export { driveAgent, readRuns, gitClean, cleanupMesh, plant };

// Domain pools. `confusable` neighbours share a topic so name-matching can't shortcut
// routing; `disjoint` are orthogonal. Each entry: { name, blurb } — the fact is planted
// per trial. Pools are large enough for the 12-peer cell.
const POOLS = {
  disjoint: [
    { name: 'billing', blurb: 'Billing and invoices.' },
    { name: 'weather', blurb: 'Weather forecasts.' },
    { name: 'library', blurb: 'Book catalog lookups.' },
    { name: 'travel', blurb: 'Flight and hotel booking.' },
    { name: 'recipes', blurb: 'Cooking recipes.' },
    { name: 'fitness', blurb: 'Workout and exercise plans.' },
    { name: 'music', blurb: 'Music and playlists.' },
    { name: 'gardening', blurb: 'Plants and gardening advice.' },
    { name: 'astronomy', blurb: 'Stars and planets.' },
    { name: 'legal', blurb: 'Legal document review.' },
    { name: 'translate', blurb: 'Language translation.' },
    { name: 'tax', blurb: 'Tax filing help.' }
  ],
  confusable: [
    { name: 'billing', blurb: 'Recurring billing cycles and statements.' },
    { name: 'payments', blurb: 'Processing one-off payments and cards.' },
    { name: 'invoicing', blurb: 'Issuing invoices to customers.' },
    { name: 'refunds', blurb: 'Refunds and chargebacks.' },
    { name: 'dunning', blurb: 'Overdue-account dunning schedules.' },
    { name: 'subscriptions', blurb: 'Subscription plans and renewals.' },
    { name: 'collections', blurb: 'Debt collection workflows.' },
    { name: 'reconciliation', blurb: 'Ledger reconciliation.' },
    { name: 'payouts', blurb: 'Vendor payouts and disbursements.' },
    { name: 'credits', blurb: 'Account credits and adjustments.' },
    { name: 'taxation', blurb: 'Sales-tax on transactions.' },
    { name: 'fraud', blurb: 'Payment fraud screening.' }
  ]
};

/**
 * Materialize a caller A wired to N specialist peers. Each peer gets a domain
 * AGENT.md + a random planted fact in `facts.md`. Returns the mesh result extended
 * with `driven:'A'` and `domains: [{ name, fact }]` (the planted ground truth the
 * scenario builds tasks from). `peers` ≤ pool size; `overlap` selects the pool.
 */
export async function buildRoutingMesh({ peers = 6, overlap = 'confusable', claude, timeoutMs = 120_000 } = {}) {
  if (!claude) throw new Error('buildRoutingMesh: a claude binary path is required');
  const pool = POOLS[overlap];
  if (!pool) throw new Error(`buildRoutingMesh: unknown overlap "${overlap}"`);
  if (peers > pool.length) throw new Error(`buildRoutingMesh: peers=${peers} exceeds ${overlap} pool (${pool.length})`);
  const chosen = pool.slice(0, peers);

  const domains = chosen.map((d) => ({ name: d.name, blurb: d.blurb, fact: plant(d.name.toUpperCase().slice(0, 6)) }));
  const agents = {
    A: { agentMd: 'General assistant. Read every peer\'s capabilities before choosing. Delegate each question '
      + 'to exactly ONE specialist peer — the single closest functional match — even when several peers cover '
      + 'related or overlapping territory. Never delegate the same question to more than one peer to hedge.',
      peers: domains.map((d) => d.name) }
  };
  for (const d of domains) {
    agents[d.name] = {
      agentMd: `${d.blurb} Capabilities: answer questions in this domain.`,
      files: { 'facts.md': `The current value for this domain is: ${d.fact}\n` }
    };
  }
  const mesh = await buildMesh({ agents, claude, timeoutMs });
  mesh.driven = 'A';
  mesh.domains = domains;
  return mesh;
}

/**
 * Build ground-truth-labelled tasks from a routing mesh's planted domains. Picks
 * `count` domains spread across the roster and phrases each FUNCTIONALLY (by the
 * domain's blurb, never the peer name) so routing is genuine, not name-matching.
 *
 * Task-first, delegate-second (dev-mesh/curator/memory/workflows/
 * task-first-delegate-prompt.md, PR #700): the task is stated first, then a short
 * trailing sentence explicitly directs delegation. Burying the delegation intent
 * inside "find the specialist who owns it" invites the model to reason about
 * whether/how to act instead of just invoking delegate_to_peer — a source of
 * routing-recall flakiness in real-LLM eval prompts (never names the peer, so
 * routing stays genuine — see the test that asserts the prompt excludes it).
 */
export function routingTasks(mesh, { count = 3 } = {}) {
  const ds = mesh.domains || [];
  const n = Math.min(count, ds.length);
  const picks = [];
  for (let i = 0; i < n; i++) picks.push(ds[Math.floor((i + 0.5) * ds.length / n)]);
  return picks.map((d) => ({
    prompt: `I need the current configured value for this area: "${d.blurb}" Delegate this to the specialist peer who owns it, then report the exact value.`,
    correctPeer: d.name,
    acceptablePeers: [d.name],
    groundTruth: d.fact,
    minimalHops: 1
  }));
}
