import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile as wf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { encodeProjectDir, recordEvent, readEvents, deriveProvenance, listSessions, resolveTranscript, setLabel, readLabels, deleteLabel, deleteSession } from '../src/dashboard/session-index.js';

test('encodeProjectDir: posix replaces / and . with -', () => {
  assert.equal(encodeProjectDir('/private/tmp/agent-mesh-demo/library', 'darwin'),
    '-private-tmp-agent-mesh-demo-library');
});

test('encodeProjectDir: win32 encodes drive path', () => {
  // C:\Users\me\agent → C--Users-me-agent. Every non-alphanumeric → '-', and there
  // is NO leading dash on Windows (the drive letter starts the name). This matches
  // the real ~/.claude/projects/<dir> Claude Code writes on Windows — verified
  // empirically against a live transcript. (The old scheme dropped '_' and force-
  // prefixed '-', so the dir was never found and the session-log stayed empty.)
  assert.equal(encodeProjectDir('C:\\Users\\me\\agent', 'win32'), 'C--Users-me-agent');
});

test('encodeProjectDir: direct compute when the computed dir exists', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj-'));
  await mkdir(join(projects, '-Users-me-agent'), { recursive: true });
  const got = encodeProjectDir('/Users/me/agent', 'darwin', { projectsDir: projects });
  assert.equal(got, '-Users-me-agent'); // computed exists → used directly
});

test('encodeProjectDir: win32 dashes underscores (and every non-alphanumeric), no leading dash', () => {
  // The regression that left the session-log empty: underscores in the path were
  // NOT dashed and a leading '-' was force-added, so the computed dir never
  // matched Claude's real ~/.claude/projects/<dir>. Every non-alphanumeric → '-',
  // drive letter stays at the front.
  assert.equal(encodeProjectDir('C:\\AI\\agents_mesh\\my-mesh\\x', 'win32'),
    'C--AI-agents-mesh-my-mesh-x');
});

test('encodeProjectDir: fallback does NOT pick a wrong sibling project (no loose suffix)', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'projx-'));
  await mkdir(join(projects, '-Users-me-agent'), { recursive: true });
  // a short path whose leaf is a suffix of the sibling dir — must NOT match it
  const got = encodeProjectDir('/agent', 'darwin', { projectsDir: projects });
  assert.equal(got, '-agent'); // falls through to computed, not '-Users-me-agent'
});

test('recordEvent/readEvents round-trip + deriveProvenance (create/select/open)', async () => {
  const meshRoot = '/tmp/mesh-' + Math.random().toString(16).slice(2);
  const agentRoot = meshRoot + '/library';
  const sid = '11111111-1111-1111-1111-111111111111';
  await recordEvent(meshRoot, { kind: 'select', source: 'dashboard', agentRoot, sessionId: sid });
  await recordEvent(meshRoot, { kind: 'open', source: 'terminal', terminalApp: 'pwsh', agentRoot, sessionId: sid });
  const events = await readEvents(meshRoot);
  assert.equal(events.filter(e => e.sessionId === sid).length, 2);
  // external session (no create) selected then opened → origin cli, last terminal
  const prov = deriveProvenance(events, sid);
  assert.equal(prov.originSource, 'cli');
  assert.equal(prov.lastManagedBy, 'terminal');
});

test('deriveProvenance: a create(dashboard) session → origin dashboard', () => {
  const sid = '22222222-2222-2222-2222-222222222222';
  const evs = [{ kind: 'create', source: 'dashboard', sessionId: sid, at: 1 },
               { kind: 'select', source: 'dashboard', sessionId: sid, at: 2 }];
  assert.equal(deriveProvenance(evs, sid).originSource, 'dashboard');
});

test('deriveProvenance: a rotate event establishes origin for the new generation', () => {
  const sid = '33333333-3333-4333-8333-333333333333';
  const events = [{ at: 5, kind: 'rotate', source: 'headroom', sessionId: sid, priorSessionId: 'old' }];
  const prov = deriveProvenance(events, sid);
  assert.equal(prov.originSource, 'headroom');
  assert.equal(prov.lastManagedBy, 'headroom');
});

// ---------------------------------------------------------------------------
// Task 3: listSessions + resolveTranscript
// ---------------------------------------------------------------------------

async function fakeTranscript(dir, name, turns) {
  const lines = [];
  lines.push(JSON.stringify({ type: 'mode', mode: 'default' }));
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `q${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } }));
  }
  await wf(join(dir, name), lines.join('\n') + '\n', 'utf8');
}

test('listSessions: exact turns/firstPrompt + lineCount cursor; resolveTranscript guards', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj2-'));
  const agentRoot = '/Users/me/lib';
  const enc = encodeProjectDir(agentRoot, 'darwin'); // computed (dir absent → computed)
  const projDir = join(projects, enc);
  await mkdir(projDir, { recursive: true });
  const sid = '33333333-3333-3333-3333-333333333333';
  await fakeTranscript(projDir, `${sid}.jsonl`, 3);

  const io = { projectsDir: projects, platform: 'darwin', meshRoot: '/tmp/m', realpath: async (p) => p };
  const rows = await listSessions(agentRoot, io);
  const row = rows.find(r => r.id === sid);
  assert.equal(row.turns, 3);
  assert.equal(row.firstPrompt, 'q0');
  assert.ok(row.lineCount >= 7);                 // uncapped line cursor max
  assert.equal(row.originSource, 'cli');

  // resolveTranscript: UUID + index-only + realpath containment
  const path = await resolveTranscript(agentRoot, sid, io);
  assert.ok(path.endsWith(`${sid}.jsonl`));
  await assert.rejects(() => resolveTranscript(agentRoot, 'not-a-uuid', io));
  await assert.rejects(() => resolveTranscript(agentRoot, '44444444-4444-4444-4444-444444444444', io)); // unknown
});

test('resolveTranscript: realpath that escapes to a sibling-prefix dir is rejected (no startsWith bypass)', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj3-'));
  const agentRoot = '/Users/me/lib2';
  const enc = encodeProjectDir(agentRoot, 'darwin');
  const projDir = join(projects, enc);
  await mkdir(projDir, { recursive: true });
  const sid = '55555555-5555-5555-5555-555555555555';
  await fakeTranscript(projDir, `${sid}.jsonl`, 1); // present in the listing (passes index check)
  // realpath maps the candidate to a SIBLING dir that shares the prefix:
  //   <projDir>Malicious/<sid>.jsonl  — startsWith(projDir) would wrongly pass.
  const realpath = async (p) => (p === projDir ? projDir : `${projDir}Malicious/${sid}.jsonl`);
  await assert.rejects(
    () => resolveTranscript(agentRoot, sid, { projectsDir: projects, platform: 'darwin', meshRoot: '/tmp/m', realpath }),
    (e) => e.code === 'containment'
  );
});

// ---------------------------------------------------------------------------
// Labels + deleteSession
// ---------------------------------------------------------------------------

test('setLabel + listSessions surfaces the label; blank clears it; readLabels tolerant', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'projL-'));
  const agentRoot = '/Users/me/lib-labels';
  const enc = encodeProjectDir(agentRoot, 'darwin');
  const projDir = join(projects, enc);
  await mkdir(projDir, { recursive: true });
  const sid = '99999999-9999-9999-9999-999999999999';
  await fakeTranscript(projDir, `${sid}.jsonl`, 1);
  const meshRoot = '/tmp/mesh-labels-' + Math.random().toString(16).slice(2);
  const io = { projectsDir: projects, platform: 'darwin', meshRoot, realpath: async (p) => p };

  // missing labels file → {}
  assert.deepEqual(await readLabels(meshRoot), {});

  const stored = await setLabel(meshRoot, sid, '  My  Cool   Session  ');
  assert.equal(stored, 'My Cool Session');                 // collapsed + trimmed
  assert.equal((await readLabels(meshRoot))[sid], 'My Cool Session');

  const rows = await listSessions(agentRoot, io);
  assert.equal(rows.find(r => r.id === sid).label, 'My Cool Session');

  // control chars/newlines stripped; cap at 80
  const ctl = await setLabel(meshRoot, sid, 'a\nb\tc');
  assert.equal(ctl, 'a b c');
  const long = await setLabel(meshRoot, sid, 'x'.repeat(200));
  assert.equal(long.length, 80);

  // blank clears
  assert.equal(await setLabel(meshRoot, sid, '   '), null);
  assert.equal((await readLabels(meshRoot))[sid], undefined);
  // a session with no label → label:null in listSessions
  assert.equal((await listSessions(agentRoot, io)).find(r => r.id === sid).label, null);
});

test('setLabel rejects a non-UUID id', async () => {
  await assert.rejects(() => setLabel('/tmp/m', 'not-a-uuid', 'x'), (e) => e.code === 'bad_id');
});

test('deleteSession resolves via resolveTranscript then unlinks the real path; bad id throws', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'projD-'));
  const agentRoot = '/Users/me/lib-del';
  const enc = encodeProjectDir(agentRoot, 'darwin');
  const projDir = join(projects, enc);
  await mkdir(projDir, { recursive: true });
  const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const file = join(projDir, `${sid}.jsonl`);
  await fakeTranscript(projDir, `${sid}.jsonl`, 1);
  const io = { projectsDir: projects, platform: 'darwin', meshRoot: '/tmp/m', realpath: async (p) => p };

  assert.ok(existsSync(file));
  const r = await deleteSession(agentRoot, sid, io);
  assert.deepEqual(r, { ok: true });
  assert.ok(!existsSync(file));                              // real transcript removed

  // bad id → bad_id (resolve gate); unknown id → not_found (no unlink)
  await assert.rejects(() => deleteSession(agentRoot, 'not-a-uuid', io), (e) => e.code === 'bad_id');
  await assert.rejects(() => deleteSession(agentRoot, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', io), (e) => e.code === 'not_found');
});
