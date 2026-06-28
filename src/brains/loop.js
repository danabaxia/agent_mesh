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
  return { reply: '', enrichment, hops, usage: null };
}
