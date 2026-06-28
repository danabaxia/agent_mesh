import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiRequest,
  parseGeminiResponse,
  makeGeminiTransport,
  runGemini,
} from '../src/brains/gemini.js';

// ---- buildGeminiRequest (pure) ----

test('buildGeminiRequest: systemInstruction + role mapping (model stays, tool→user) + thinkingBudget 0', () => {
  const body = buildGeminiRequest({
    systemPrompt: 'OBEY',
    contents: [
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'hello' },
      { role: 'tool', text: 'tool mesh_status: {"open":2}' },
    ],
    toolSpecs: [],
  });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'OBEY' }] });
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']); // tool→user
  assert.deepEqual(body.contents[2].parts, [{ text: 'tool mesh_status: {"open":2}' }]);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal('tools' in body, false); // no toolSpecs → no tools key
});

test('buildGeminiRequest: toolSpecs become functionDeclarations', () => {
  const specs = [{ name: 'propose_idea', description: 'd', parameters: { type: 'object', properties: {} } }];
  const body = buildGeminiRequest({ systemPrompt: 's', contents: [{ role: 'user', text: 'x' }], toolSpecs: specs });
  assert.deepEqual(body.tools, [{ functionDeclarations: specs }]);
});

// ---- parseGeminiResponse (pure) ----

test('parseGeminiResponse: a functionCall part → functionCall result', () => {
  const json = {
    candidates: [{ content: { parts: [{ functionCall: { name: 'mesh_status', args: { x: 1 } } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
  const out = parseGeminiResponse(json);
  assert.deepEqual(out.functionCall, { name: 'mesh_status', args: { x: 1 } });
  assert.equal(out.text, '');
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
});

test('parseGeminiResponse: text parts are concatenated', () => {
  const json = { candidates: [{ content: { parts: [{ text: 'Three ' }, { text: 'issues.' }] } }] };
  const out = parseGeminiResponse(json);
  assert.equal(out.text, 'Three issues.');
  assert.equal(out.functionCall, null);
  assert.equal(out.usage, null); // no usageMetadata
});

test('parseGeminiResponse: malformed/empty response is safe', () => {
  assert.deepEqual(parseGeminiResponse({}), { text: '', functionCall: null, usage: null });
  assert.deepEqual(parseGeminiResponse(null), { text: '', functionCall: null, usage: null });
});

// ---- makeGeminiTransport (injected fetch — NO network) ----

test('makeGeminiTransport: POSTs to the model endpoint with the api key header and built body', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) };
  };
  const transport = makeGeminiTransport({ apiKey: 'SECRET', model: 'gemini-2.5-flash', fetchImpl: fakeFetch });
  const out = await transport({ systemPrompt: 's', contents: [{ role: 'user', text: 'hi' }], toolSpecs: [] });
  assert.equal(out.text, 'ok');
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'SECRET');
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.deepEqual(sentBody.contents[0], { role: 'user', parts: [{ text: 'hi' }] });
});

test('makeGeminiTransport: a non-ok response throws (does not silently return junk)', async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const transport = makeGeminiTransport({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch });
  await assert.rejects(
    () => transport({ systemPrompt: 's', contents: [{ role: 'user', text: 'x' }], toolSpecs: [] }),
    /gemini 429/,
  );
});

test('makeGeminiTransport: missing api key throws at construction', () => {
  assert.throws(() => makeGeminiTransport({ apiKey: '', model: 'm' }), /GEMINI_API_KEY/);
});

// ---- end-to-end through runGemini with the real transport + fake fetch ----

test('runGemini over the real transport (fake fetch): functionCall → toolCall', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 'propose_idea', args: { title: 'X' } } }] } }] }),
  });
  const transport = makeGeminiTransport({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch });
  const out = await runGemini({ systemPrompt: 's', messages: [{ role: 'user', text: 'idea: X' }], toolSpecs: [{ name: 'propose_idea' }], transport });
  assert.deepEqual(out.toolCall, { name: 'propose_idea', args: { title: 'X' } });
});
