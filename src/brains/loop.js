/**
 * Model-agnostic bounded tool loop. `brain` is the swappable model step:
 *   brain({ systemPrompt, messages, toolSpecs, signal }) -> { reply? , toolCall? }
 * Returns the final reply text + any captured enrichment.
 */
export async function runBrainLoop({ systemPrompt, messages, tools, brain, maxHops = 4, signal } = {}) {
  const convo = [...messages];
  let enrichment = null;
  let hops = 0;
  while (hops < maxHops) {
    hops++;
    const step = await brain({ systemPrompt, messages: convo, toolSpecs: tools.specs, signal });
    if (step?.toolCall) {
      const { name, args = {} } = step.toolCall;
      const result = await tools.dispatch(name, args, { signal });
      if (result && result.__enrichment) enrichment = result.__enrichment;
      const { __enrichment, ...visible } = result || {};
      convo.push({ role: 'tool', name, content: JSON.stringify(visible) });
      continue;
    }
    return { reply: String(step?.reply ?? ''), enrichment, hops, usage: step?.usage ?? null };
  }
  // Hop budget exhausted while still calling tools. Rather than return an empty reply
  // (a weaker model can loop on tools and never relay), force ONE final turn with NO
  // tools offered — the brain must then produce a spoken reply, relaying what it
  // gathered (e.g. the peer's ask_peer answer). If it still emits a toolCall, we ignore
  // it and return '' gracefully.
  const final = await brain({ systemPrompt, messages: convo, toolSpecs: [], signal });
  return { reply: String(final?.reply ?? ''), enrichment, hops, usage: final?.usage ?? null };
}
