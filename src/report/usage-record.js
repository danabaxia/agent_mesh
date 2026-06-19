// src/report/usage-record.js
// Pure shaper: a claude result envelope + the GitHub env → the per-run usage
// record uploaded as an artifact and later aggregated on the host. Keep the raw
// envelope `usage`/cost/turns fields so aggregate's extractUsage reads them.
export function buildUsageRecord(envelope, env = process.env, nowIso = () => new Date().toISOString()) {
  const e = envelope && typeof envelope === 'object' ? envelope : {};
  const u = e.usage && typeof e.usage === 'object' ? e.usage : {};
  return {
    ts: nowIso(),
    workflow: env.GITHUB_WORKFLOW || null,
    runId: env.GITHUB_RUN_ID || null,
    ref: env.GITHUB_REF || null,
    usage: {
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
      total_cost_usd: e.total_cost_usd ?? null,
      num_turns: e.num_turns ?? null,
    },
  };
}
