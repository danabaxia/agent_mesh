/**
 * src/routing.js
 *
 * PURE routing core for the orchestrator. Given a user task and the peers'
 * (sanitized) cards, decide the cheapest path:
 *   - rule pass: a declared `intent` matches → route directly to that peer's
 *     deterministic primaryTool (zero LLM);
 *   - otherwise → `llm-needed`, and the orchestrator runs ONE structured turn
 *     using `buildRoutingPrompt()` (the LLM execution itself is the shell, in
 *     orchestrator.js — this module stays pure/testable).
 */

const FILLER = ['the', 'a', 'an', 'for me', 'please', 'for you', 'can you', 'to', 'for', 'me'];

/**
 * @param {string} task
 * @param {Array<{ name, primaryTool?: { tool, intents?, argsSchema? } }>} peers
 * @returns {{ route: 'tool', target, toolCall: {tool,args}, source:'rule' }
 *         | { route: 'llm-needed' }}
 */
export function routeByRules(task, peers) {
  if (typeof task !== 'string' || !task.trim() || !Array.isArray(peers)) {
    return { route: 'llm-needed' };
  }
  const lower = task.toLowerCase();

  for (const peer of peers) {
    const pt = peer?.primaryTool;
    if (!pt || typeof pt.tool !== 'string') continue;
    const intents = Array.isArray(pt.intents) ? pt.intents : [];
    // Prefer the LONGEST matching intent phrase (more specific → better extraction).
    const matched = intents
      .filter((i) => typeof i === 'string' && i && lower.includes(i.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    if (!matched) continue;

    const query = extractQuery(task, matched);
    if (!query) continue; // matched an intent but nothing left to query on → let the LLM decide
    return {
      route: 'tool',
      target: peer.name,
      toolCall: { tool: pt.tool, args: buildArgs(pt.argsSchema, query) },
      source: 'rule'
    };
  }
  return { route: 'llm-needed' };
}

/** Strip the matched intent phrase + surrounding filler to recover the query. */
export function extractQuery(task, intent) {
  let q = task.replace(new RegExp(escapeRegex(intent), 'i'), ' ');
  // strip leading article
  q = q.replace(/^\s*(the|a|an)\s+/i, ' ');
  // strip filler words anywhere
  for (const f of FILLER) q = q.replace(new RegExp(`\\b${escapeRegex(f)}\\b`, 'gi'), ' ');
  return q.replace(/\s+/g, ' ').trim();
}

/** Place the recovered query into the declared argsSchema's first string field. */
function buildArgs(argsSchema, query) {
  if (argsSchema && typeof argsSchema === 'object' && !Array.isArray(argsSchema)) {
    const key = Object.keys(argsSchema).find((k) => argsSchema[k] === 'string') || Object.keys(argsSchema)[0];
    if (key) return { [key]: query };
  }
  return { query };
}

/**
 * Build the structured-output prompt for the LLM fallback turn. The model returns
 * a single JSON object describing the route; the orchestrator parses + validates
 * it against the same peer cards (never trusting it to name an undeclared tool).
 */
export function buildRoutingPrompt(task, peers) {
  const catalogue = peers.map((p) => ({
    name: p.name,
    modes: p.modes || [],
    primaryTool: p.primaryTool ? { tool: p.primaryTool.tool, intents: p.primaryTool.intents || [], argsSchema: p.primaryTool.argsSchema || null } : null
  }));
  return [
    'You are a routing function for a mesh of agents. Decide how to handle the user task.',
    'Peers (and their deterministic primaryTool, if any):',
    JSON.stringify(catalogue, null, 2),
    '',
    `User task: ${JSON.stringify(task)}`,
    '',
    'Output ONE JSON object, nothing else:',
    '  { "route": "tool", "target": "<peer>", "toolCall": { "tool": "<declared tool>", "args": { ... } } }',
    '    — when a peer\'s primaryTool can answer directly (fill args from the task), OR',
    '  { "route": "agent", "target": "<peer>", "task": "<a clear, scoped task for that agent>" }',
    '    — when the task needs the agent to reason, OR',
    '  { "route": "none" } — when no peer fits.',
    'Only name a tool/peer that exists above. Prefer "tool" when a primaryTool clearly matches.'
  ].join('\n');
}

/**
 * Validate a parsed LLM routing decision against the peer cards. Returns a
 * normalized decision or { route:'none' } if it references anything undeclared.
 */
export function validateLlmDecision(decision, peers) {
  if (!decision || typeof decision !== 'object') return { route: 'none' };
  const peer = peers.find((p) => p.name === decision.target);
  if (decision.route === 'tool') {
    if (!peer?.primaryTool || decision.toolCall?.tool !== peer.primaryTool.tool) return { route: 'none' };
    const args = (decision.toolCall.args && typeof decision.toolCall.args === 'object') ? decision.toolCall.args : {};
    return { route: 'tool', target: peer.name, toolCall: { tool: peer.primaryTool.tool, args }, source: 'llm' };
  }
  if (decision.route === 'agent') {
    if (!peer) return { route: 'none' };
    const task = typeof decision.task === 'string' && decision.task.trim() ? decision.task : null;
    if (!task) return { route: 'none' };
    return { route: 'agent', target: peer.name, task, source: 'llm' };
  }
  return { route: 'none' };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
