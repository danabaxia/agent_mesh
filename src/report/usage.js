// src/report/usage.js
// Pure token-usage normalizer. Accepts either a RAW claude result envelope
// (usage nested, total_cost_usd/num_turns top-level) or a LOCAL run record /
// usage block (cost/turns flattened inside `usage`). Always returns the same
// flat numeric shape; never throws.

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 0, model: null };
}

export function extractUsage(src) {
  if (!src || typeof src !== 'object') return emptyUsage();
  const u = src.usage && typeof src.usage === 'object' ? src.usage : src;
  const model = typeof src.model === 'string' ? src.model
    : (typeof u.model === 'string' ? u.model : null);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    // cost/turns may be top-level (raw envelope) or inside usage (normalized record)
    costUsd: num(src.total_cost_usd ?? u.total_cost_usd),
    turns: num(src.num_turns ?? u.num_turns),
    model,
  };
}

export function sumUsage(usages) {
  const out = emptyUsage();
  for (const u of usages) {
    out.input += num(u.input); out.output += num(u.output);
    out.cacheRead += num(u.cacheRead); out.cacheCreation += num(u.cacheCreation);
    out.costUsd += num(u.costUsd); out.turns += num(u.turns);
  }
  return out;  // model stays null on a sum (heterogeneous)
}
