import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  occupancyFromUsage, headroomPctOf, usageFromTail, readSessionHeadroom, encodeProjectDir
} from '../src/session-transcripts.js';

const SID = '11111111-2222-4333-8444-555555555555';

// A transcript "assistant" record with usage, as Claude Code writes it.
const aLine = (usage, text = 'hi') => JSON.stringify({
  type: 'assistant', timestamp: '2026-06-12T00:00:00Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage }
});
const uLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const USAGE = { input_tokens: 100_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000, output_tokens: 50 };

// Fake ~/.claude/projects layout for an agent root, via the io seam.
async function fixture(lines) {
  const base = await mkdtemp(join(tmpdir(), 'hr-'));
  // realpath AFTER mkdir so the fixture encodes the SAME canonical root the
  // product looks up (resolveTranscript canonicalizes agentRoot before encoding).
  // On Windows os.tmpdir() returns an 8.3 SHORT path that realpath expands to the
  // LONG form; a raw-mkdtemp encoding would diverge and the lookup would miss.
  await mkdir(join(base, 'agent'));
  const agentRoot = await realpath(join(base, 'agent'));
  const projectsDir = join(base, 'projects');
  const enc = encodeProjectDir(agentRoot, 'linux', { projectsDir });
  await mkdir(join(projectsDir, enc), { recursive: true });
  const path = join(projectsDir, enc, `${SID}.jsonl`);
  await writeFile(path, lines.join('\n') + '\n');
  return { agentRoot, projectsDir, path, io: { projectsDir, platform: 'linux' } };
}

test('occupancyFromUsage sums the three input fields; null on garbage', () => {
  assert.equal(occupancyFromUsage(USAGE), 150_000);
  assert.equal(occupancyFromUsage({ input_tokens: 5 }), 5);
  assert.equal(occupancyFromUsage(null), null);
  assert.equal(occupancyFromUsage({ output_tokens: 9 }), null); // no input-side fields
});

test('headroomPctOf computes clamped integer percent; null on bad input', () => {
  assert.equal(headroomPctOf(150_000, 200_000), 25);
  assert.equal(headroomPctOf(250_000, 200_000), 0);
  assert.equal(headroomPctOf(0, 200_000), null);   // 0 occupancy = no signal
  assert.equal(headroomPctOf(100, 0), null);
});

test('usageFromTail finds the LAST assistant usage', async () => {
  const { path } = await fixture([
    uLine('q1'), aLine({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    uLine('q2'), aLine(USAGE)
  ]);
  const u = await usageFromTail(path);
  assert.equal(u.occupancy, 150_000);
  assert.ok(u.atMtime > 0);
});

test('usageFromTail: no usage anywhere → null; usage only beyond the tail window → null', async () => {
  const none = await fixture([uLine('q'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })]);
  assert.equal(await usageFromTail(none.path), null);
  const pad = uLine('x'.repeat(1000));
  const big = await fixture([aLine(USAGE), ...Array.from({ length: 400 }, () => pad)]);
  assert.equal(await usageFromTail(big.path, { tailBytes: 8 * 1024 }), null); // usage line is in the head
});

test('usageFromTail drops the partial first line of a mid-file tail window', async () => {
  const pad = uLine('y'.repeat(1000));
  const { path } = await fixture([...Array.from({ length: 50 }, () => pad), aLine(USAGE)]);
  const u = await usageFromTail(path, { tailBytes: 2048 }); // window starts mid-pad-line
  assert.equal(u.occupancy, 150_000);
});

test('usageFromTail skips a later usage-less assistant line for an earlier one with usage', async () => {
  const { path } = await fixture([
    aLine(USAGE),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } }) // no usage
  ]);
  assert.equal((await usageFromTail(path)).occupancy, 150_000);
});

test('readSessionHeadroom resolves via the containment gate and computes pct', async () => {
  const { agentRoot, io } = await fixture([aLine(USAGE)]);
  const h = await readSessionHeadroom(agentRoot, SID, { ...io, contextWindow: 200_000 });
  assert.deepEqual({ occupancy: h.occupancy, headroomPct: h.headroomPct }, { occupancy: 150_000, headroomPct: 25 });
});

test('readSessionHeadroom: unknown session → null; containment violation PROPAGATES', async () => {
  const { agentRoot, io } = await fixture([aLine(USAGE)]);
  assert.equal(await readSessionHeadroom(agentRoot, '99999999-9999-4999-8999-999999999999', io), null);
  // io.realpath seam: pretend the transcript resolves OUTSIDE the project dir.
  const evil = { ...io, realpath: async (p) => p.endsWith('.jsonl') ? '/etc/evil.jsonl' : p };
  await assert.rejects(() => readSessionHeadroom(agentRoot, SID, evil), (e) => e.code === 'containment');
});
