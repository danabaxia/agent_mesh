/**
 * The real Gemini brain step. The live HTTP call is injected as `transport`
 * (default builds a REST transport over Node's built-in `fetch` — NO npm SDK,
 * preserving the zero-dep invariant) so importing this module never requires a
 * dependency and every test runs with a fake `fetch` / fake transport. The live
 * call is the ONLY out-of-gate path; the request-building and response-parsing
 * are pure and fully unit-tested.
 *
 * transport({ systemPrompt, contents, toolSpecs, signal })
 *   -> { text: string, functionCall: { name, args } | null, usage?: object }
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export async function runGemini({ systemPrompt, messages, toolSpecs = [], signal, transport } = {}) {
  const call = transport || defaultTransport();
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'tool' : 'user',
    text: m.role === 'tool' ? `tool ${m.name}: ${m.content}` : m.text,
  }));
  const res = await call({ systemPrompt, contents, toolSpecs, signal });
  if (res.functionCall) return { toolCall: { name: res.functionCall.name, args: res.functionCall.args || {} } };
  return { reply: res.text || '', usage: res.usage || null };
}

/**
 * Build the Gemini REST `generateContent` request body from the neutral
 * transport input. Pure. Roles map model→model, everything else (user/tool)→user
 * (REST accepts only user/model/function; tool results ride as user turns —
 * their text already names the tool). `thinkingBudget: 0` keeps it answer-first
 * for spoken latency.
 */
export function buildGeminiRequest({ systemPrompt, contents = [], toolSpecs = [] }) {
  const body = {
    contents: contents.map((c) => ({
      role: c.role === 'model' ? 'model' : 'user',
      parts: [{ text: c.text ?? '' }],
    })),
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (toolSpecs && toolSpecs.length) body.tools = [{ functionDeclarations: toolSpecs }];
  return body;
}

/**
 * Parse a Gemini REST `generateContent` response into the neutral transport
 * output. Pure, null-safe. A functionCall part wins; otherwise text parts are
 * concatenated. usageMetadata maps to the run-record token shape.
 */
export function parseGeminiResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p && p.functionCall) {
      return { text: '', functionCall: { name: p.functionCall.name, args: p.functionCall.args || {} }, usage: usageOf(json) };
    }
  }
  const text = parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('');
  return { text, functionCall: null, usage: usageOf(json) };
}

function usageOf(json) {
  const u = json?.usageMetadata;
  if (!u) return null;
  return {
    input_tokens: u.promptTokenCount ?? null,
    output_tokens: u.candidatesTokenCount ?? null,
    total_tokens: u.totalTokenCount ?? null,
  };
}

/**
 * Construct a live Gemini transport over `fetch`. `fetchImpl` is injectable so
 * the gate never hits the network; production uses Node's global `fetch`. The
 * api key is sent in the `x-goog-api-key` header (never logged).
 */
export function makeGeminiTransport({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, base = GEMINI_API_BASE } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set — cannot build the gemini transport');
  const url = `${base}/models/${model}:generateContent`;
  return async ({ systemPrompt, contents, toolSpecs, signal }) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(buildGeminiRequest({ systemPrompt, contents, toolSpecs })),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`gemini ${res.status}: ${String(detail).slice(0, 200)}`);
    }
    return parseGeminiResponse(await res.json());
  };
}

/**
 * The deploy-time default transport: live REST over global `fetch`, keyed by
 * GEMINI_API_KEY (loaded from the box's `.voice-env`, never committed). Built
 * lazily per call so a process without a key only fails when a turn actually
 * runs, not at import.
 */
function defaultTransport() {
  return async (req) =>
    makeGeminiTransport({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
    })(req);
}
