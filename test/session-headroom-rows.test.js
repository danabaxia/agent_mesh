import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions } from '../src/dashboard/session-index.js';
import { encodeProjectDir } from '../src/session-transcripts.js';

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USAGE = { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const aLine = (usage) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage } });
const uLine = JSON.stringify({ type: 'user', message: { content: 'q' } });

async function fixture(lines) {
  const base = await mkdtemp(join(tmpdir(), 'rows-'));
  // realpath AFTER mkdir so the fixture encodes the SAME canonical root the
  // product looks up (resolveTranscript canonicalizes agentRoot before encoding).
  // On Windows os.tmpdir() returns an 8.3 SHORT path that realpath expands to the
  // LONG form; a raw-mkdtemp encoding would diverge and the lookup would miss.
  await mkdir(join(base, 'agent'));
  const agentRoot = await realpath(join(base, 'agent'));
  const projectsDir = join(base, 'projects');
  const enc = encodeProjectDir(agentRoot, 'linux', { projectsDir });
  await mkdir(join(projectsDir, enc), { recursive: true });
  await writeFile(join(projectsDir, enc, `${SID}.jsonl`), lines.join('\n') + '\n');
  return { agentRoot, io: { projectsDir, platform: 'linux' } };
}

test('rows carry headroomPct from the last assistant usage', async () => {
  const { agentRoot, io } = await fixture([uLine, aLine(USAGE)]);
  const [row] = await listSessions(agentRoot, io);
  assert.equal(row.id, SID);
  assert.equal(row.headroomPct, 25); // 150k of the 200k default window
});

test('rows degrade to headroomPct null when no usage exists', async () => {
  const { agentRoot, io } = await fixture([uLine, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })]);
  const [row] = await listSessions(agentRoot, io);
  assert.equal(row.headroomPct, null);
});

test('large transcripts (beyond the preview cap) still get headroom via the tail read', async () => {
  // Build a file > 2MB where the ONLY usage line is at the END (outside the head buffer).
  // Using valid-JSON pad lines to avoid any ambiguity with parseTranscriptLine assumptions.
  const pad = JSON.stringify({ type: 'user', message: { content: 'pad '.repeat(1000) } });
  const lines = Array.from({ length: 600 }, () => pad);
  lines.push(aLine(USAGE));
  const { agentRoot, io } = await fixture(lines);
  const [row] = await listSessions(agentRoot, io);
  assert.equal(row.turnsApprox, true);     // confirms the head buffer was capped
  assert.equal(row.headroomPct, 25);       // tail fallback found the usage
});
