/**
 * The real Gemini brain step. The live API call is injected as `transport`
 * (default lazily builds the google-genai client) so importing this module
 * never requires the dependency and every test runs with a fake transport.
 * This is the ONLY live-model code path; it is never in the test gate.
 *
 * transport({ systemPrompt, contents, toolSpecs, signal })
 *   -> { text: string, functionCall: { name, args } | null, usage?: object }
 */
export async function runGemini({ systemPrompt, messages, toolSpecs = [], signal, transport } = {}) {
  const call = transport || (await defaultTransport());
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'tool' : 'user',
    text: m.role === 'tool' ? `tool ${m.name}: ${m.content}` : m.text,
  }));
  const res = await call({ systemPrompt, contents, toolSpecs, signal });
  if (res.functionCall) return { toolCall: { name: res.functionCall.name, args: res.functionCall.args || {} } };
  return { reply: res.text || '', usage: res.usage || null };
}

async function defaultTransport() {
  // Lazily constructed; requires GEMINI_API_KEY + the google-genai runtime on the box.
  // Implemented at deploy time on the voice box (Task 7 production wiring), not in the gate.
  return async () => { throw new Error('gemini transport not configured (set GEMINI_API_KEY and wire google-genai)'); };
}
