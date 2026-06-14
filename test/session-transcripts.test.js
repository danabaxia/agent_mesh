// test/session-transcripts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, resolveTranscript, transcriptExists } from '../src/session-transcripts.js';

test('encodeProjectDir: win32 every non-alnum -> "-", no leading dash', () => {
  assert.equal(encodeProjectDir('C:\\AI\\agents_mesh\\x', 'win32'), 'C--AI-agents-mesh-x');
});

test('transcriptExists: true when the transcript file is present, false on not_found', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    const enc = encodeProjectDir('/Users/me/agent', 'darwin');
    await mkdir(join(projects, enc), { recursive: true });
    const io = { projectsDir: projects, platform: 'darwin' };
    assert.equal(await transcriptExists('/Users/me/agent', id, io), false);   // dir exists, file absent
    await writeFile(join(projects, enc, `${id}.jsonl`), '{}\n');
    assert.equal(await transcriptExists('/Users/me/agent', id, io), true);
  } finally { await rm(projects, { recursive: true, force: true }); }
});

test('countTurns: counts user_text events only; null when transcript absent', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj-'));
  try {
    const id = '22222222-2222-4222-8222-222222222222';
    const enc = encodeProjectDir('/Users/me/agent', 'darwin');
    await mkdir(join(projects, enc), { recursive: true });
    const io = { projectsDir: projects, platform: 'darwin' };
    const { countTurns } = await import('../src/session-transcripts.js');
    assert.equal(await countTurns('/Users/me/agent', id, io), null);   // absent → null
    const lines = [
      { type: 'user', message: { content: 'first question' } },                                    // turn 1 (string)
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },             // not a turn
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [] }] } }, // tool result, not a turn
      { type: 'user', message: { content: [{ type: 'text', text: 'second question' }] } },         // turn 2 (array text)
      { type: 'system', subtype: 'whatever' }                                                      // ignored
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    await writeFile(join(projects, enc, `${id}.jsonl`), lines);
    assert.equal(await countTurns('/Users/me/agent', id, io), 2);
  } finally { await rm(projects, { recursive: true, force: true }); }
});
