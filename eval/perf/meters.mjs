// eval/perf/meters.mjs — numeric metric extractors for the performance benchmark.
// Spec: docs/superpowers/specs/2026-06-13-mesh-perf-benchmark-design.md §6.
//
// Each meter is a PURE factory → { name, compute(ctx) -> {metric: value, ...} }.
// ctx = { task, result, runs, fixture, judgeScore }:
//   task        — the scenario task label { prompt, correctPeer, acceptablePeers,
//                 groundTruth, minimalHops }
//   result      — one driveAgent result { answer, runId, task(A2A Task), ... }
//   runs        — { agentName: [run records] } from readRuns (state:'done')
//   fixture     — the buildRoutingMesh result { meshRoot, agents }
//   judgeScore  — ordinal 0|0.5|1 (or null) pre-computed by the impure harness, so
//                 the meter stays pure/hermetic (no spawn).
//
// Cost/tokens are read from the RUN RECORDS' `usage` (added by delegate cost-capture);
// latency is read from the root A2A Task's `agentmesh/metrics` block (normalizeMetrics
// passes total_ms/worker_run_ms but strips token fields — hence the split source).

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Flatten { agent: [records] } into [{ ...record, agent }]. */
function flatRuns(runs) {
  const out = [];
  for (const [agent, recs] of Object.entries(runs || {})) {
    for (const r of (recs || [])) out.push({ ...r, agent });
  }
  return out;
}

/** Run ids reachable from `anchor` via parent_run_id edges (the task subtree). */
function subtree(anchor, flat) {
  if (!anchor) return { ids: new Set(), records: [] };
  const childrenOf = new Map();
  for (const r of flat) {
    const p = r.parent_run_id;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(r);
  }
  const ids = new Set([anchor]);
  const records = [];
  const queue = [anchor];
  while (queue.length) {
    const id = queue.shift();
    for (const child of (childrenOf.get(id) || [])) {
      if (ids.has(child.id)) continue;       // guard against any id cycle
      ids.add(child.id);
      records.push(child);
      queue.push(child.id);
    }
  }
  return { ids, records };  // records excludes the root anchor itself
}

function durationMs(rec) {
  const a = Date.parse(rec.started_at), b = Date.parse(rec.finished_at);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

function rootMetrics(result) {
  const m = result?.task?.metadata?.['agentmesh/metrics'];
  return m && typeof m === 'object' ? m : null;
}

/**
 * Routing — scored from delegation EDGES, not answer text (robust to the
 * read-anywhere confound).
 */
export function routing() {
  return { name: 'routing', compute(ctx) {
    const driven = ctx.fixture?.driven || ctx.task?.driven || 'A';
    const anchor = ctx.result?.runId ?? null;
    const flat = flatRuns(ctx.runs);
    // direct delegates: a non-driven agent whose run is parented by A's root run.
    const direct = new Set(
      flat.filter((r) => r.agent !== driven && r.parent_run_id === anchor).map((r) => r.agent)
    );
    const acceptable = new Set(ctx.task?.acceptablePeers || (ctx.task?.correctPeer ? [ctx.task.correctPeer] : []));
    const delegated = [...direct];
    const hit = delegated.filter((p) => acceptable.has(p));
    const precision = delegated.length === 0
      ? (acceptable.size === 0 ? 1 : 0)            // none needed & none done → 1
      : hit.length / delegated.length;
    const recall = ctx.task?.correctPeer ? (direct.has(ctx.task.correctPeer) ? 1 : 0) : 1;
    const actualHops = subtree(anchor, flat).records.length;   // all edges below A
    const wasted = Math.max(0, actualHops - (numOrNull(ctx.task?.minimalHops) ?? 0));
    return {
      delegated_peers: delegated.length,
      precision,
      recall,
      wrong_peer: delegated.some((p) => !acceptable.has(p)) ? 1 : 0,
      wasted_hops: wasted
    };
  } };
}

/** Efficiency — durations + tokens/cost from run records; overhead from root metrics. */
export function efficiency() {
  return { name: 'efficiency', compute(ctx) {
    const anchor = ctx.result?.runId ?? null;
    const flat = flatRuns(ctx.runs);
    const rootRec = flat.find((r) => r.id === anchor) || null;
    const { records: descendants } = subtree(anchor, flat);
    const all = rootRec ? [rootRec, ...descendants] : descendants;

    const sum = (pick) => all.reduce((n, r) => n + (pick(r) ?? 0), 0);
    const tokens_in = sum((r) => numOrNull(r.usage?.input_tokens));
    const tokens_out = sum((r) => numOrNull(r.usage?.output_tokens));
    const worker_ms = sum((r) => durationMs(r));

    const rm = rootMetrics(ctx.result);
    const latency_ms = rm ? numOrNull(rm.total_ms) : (rootRec ? durationMs(rootRec) : null);
    const overhead_ms = rm && numOrNull(rm.total_ms) != null && numOrNull(rm.worker_run_ms) != null
      ? Math.max(0, rm.total_ms - rm.worker_run_ms)
      : null;
    // Prefer subtree_cost_usd from the root Task metrics when present (single
    // accurate field, no run-log correlation needed). Fall back to summing
    // usage.total_cost_usd across all run records for older agents or errors.
    const rmSubtree = rm ? numOrNull(rm.subtree_cost_usd) : null;
    const cost_usd = rmSubtree !== null
      ? rmSubtree
      : all.reduce((n, r) => n + (numOrNull(r.usage?.total_cost_usd) ?? 0), 0);

    return {
      latency_ms,
      worker_ms,
      overhead_ms,
      tokens_in,
      tokens_out,
      tokens_total: tokens_in + tokens_out,
      cost_usd,
      hops: descendants.length
    };
  } };
}

/** Quality — cheap contains-truth proxy + the harness-supplied judge score. */
export function quality() {
  return { name: 'quality', compute(ctx) {
    const answer = ctx.result?.answer || '';
    const truth = ctx.task?.groundTruth || '';
    return {
      contains_truth: truth && answer.includes(truth) ? 1 : 0,
      judge_score: numOrNull(ctx.judgeScore)
    };
  } };
}

/** The standard meter set a scenario gets by default. */
export const meters = { routing, efficiency, quality };
