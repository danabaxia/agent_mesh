import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractForDigest } from '../src/digest-extract.js';

const u = (text) => JSON.stringify({ type: 'user', message: { content: text } });
const a = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } });
const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'HUGE TOOL DUMP' }] } });

async function transcript(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'dx-'));
  const path = join(dir, 'x.jsonl');
  await writeFile(path, lines.join('\n') + '\n');
  return path;
}

test('zero-byte and effectively-empty transcripts yield an empty extract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dx-empty-'));
  const zero = join(dir, 'zero.jsonl');
  await writeFile(zero, '');                       // true 0-byte file → cap===0 path
  assert.equal(await extractForDigest(zero), '');
  const blank = await transcript([]);              // single '\n' → no kept sections
  assert.equal(await extractForDigest(blank), '');
});

test('keeps user/assistant text chronologically; drops tool dumps; redacts secrets', async () => {
  const path = await transcript([u('q1 with ghp_abcdefghijklmnopqrstuv'), tool, toolResult, a('a1')]);
  const out = await extractForDigest(path);
  assert.match(out, /USER: q1/);
  assert.match(out, /«redacted»/);
  assert.match(out, /ASSISTANT: a1/);
  assert.doesNotMatch(out, /HUGE TOOL DUMP/);
  assert.doesNotMatch(out, /tool_use/);
  assert.ok(out.indexOf('USER: q1') < out.indexOf('ASSISTANT: a1'));
});

test('newest-first budget: oldest content is dropped, output stays chronological', async () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(u(`question ${i} ${'pad'.repeat(40)}`));
  const path = await transcript(lines);
  const out = await extractForDigest(path, { maxChars: 2_000 });
  assert.ok(out.length <= 2_000);
  assert.doesNotMatch(out, /question 0 /);
  assert.match(out, /question 199 /);
  const m = [...out.matchAll(/question (\d+) /g)].map((x) => Number(x[1]));
  assert.deepEqual(m, [...m].sort((x, y) => x - y)); // chronological
});

test('the READ itself is bounded: content beyond 4x budget from the end is never parsed', async () => {
  const marker = u('NEEDLE_IN_HEAD');
  const pad = u('z'.repeat(1000));
  const path = await transcript([marker, ...Array.from({ length: 50 }, () => pad)]);
  const out = await extractForDigest(path, { maxChars: 1_000 }); // reads only last ~4KB
  assert.doesNotMatch(out, /NEEDLE_IN_HEAD/);
});
