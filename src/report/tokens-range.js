// src/report/tokens-range.js
// Pure: fold an array of per-date Daily Mesh Report models (each with the
// `tokens` shape from aggregate.js) into the dashboard token-panel model for a
// range (today/week/month). No I/O — the route reads the dated caches and calls this.

const sum = (u) => (Number(u?.input) || 0) + (Number(u?.output) || 0);

/** One daily model → flat per-day token totals. */
export function tokenTotals(model) {
  const t = (model && model.tokens) || {};
  return {
    input: Number(t.total?.input) || 0,
    output: Number(t.total?.output) || 0,
    local: sum(t.local),
    ci: sum(t.ci),
    cost: Number(t.local?.costUsd) || 0,          // ci is $0 on subscription auth
    turns: Number(t.total?.turns) || 0,
    runs: (Number(t.local?.runs) || 0) + (Number(t.ci?.runs) || 0),
  };
}

function addConsumer(map, name, kind, tokens) {
  if (!map[name]) map[name] = { kind, tokens: 0 };
  map[name].tokens += tokens;
}

/**
 * @param {object[]} models  daily report models, ascending by date
 * @returns token-panel model: totals + local/ci split + byConsumer + per-day trend
 */
export function aggregateRange(models = []) {
  let input = 0, output = 0, local = 0, ci = 0, cost = 0, turns = 0, runs = 0;
  const consumers = {};
  const trend = [];
  for (const m of models) {
    const f = tokenTotals(m);
    input += f.input; output += f.output; local += f.local; ci += f.ci;
    cost += f.cost; turns += f.turns; runs += f.runs;
    trend.push({ date: m && m.date, tokens: f.input + f.output });
    const t = (m && m.tokens) || {};
    for (const [k, u] of Object.entries(t.local?.byRoute || {})) addConsumer(consumers, k, 'agent', sum(u));
    for (const [k, u] of Object.entries(t.ci?.byWorkflow || {})) addConsumer(consumers, k, 'ci', sum(u));
  }
  const byConsumer = Object.entries(consumers)
    .map(([name, o]) => ({ name, kind: o.kind, tokens: o.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  return { input, output, total: input + output, local, ci, cost, turns, runs, days: models.length, byConsumer, trend };
}
