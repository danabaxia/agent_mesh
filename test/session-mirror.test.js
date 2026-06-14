import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionMirror } from '../src/dashboard/session-mirror.js';

const L = (o) => JSON.stringify(o) + '\n';
const userline = (t) => L({ type: 'user', message: { role: 'user', content: t } });
const asstline = (t) => L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

test('mirror: line records carry a stable seq = line index; late subscriber replays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('hi') + asstline('hello'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 50 });
  const got = [];
  const sub = await mirror.subscribe('S1', f, (rec) => got.push(rec), 0);
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(got.map(r => r.seq), [1, 2]);
  assert.equal(got[0].events[0].type, 'user_text');
  // append a line → streamed with seq 3
  await appendFile(f, userline('again'));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(got[got.length - 1].seq, 3);
  sub.close(); mirror.close();
});

test('mirror: fresh tailer + lastSeq at EOF → no gap, no replay; future appends still delivered', async () => {
  // The normal frontend case: a brand-new tailer subscribes with a cursor that is
  // already at the END of the file. It must NOT false-gap and must NOT re-deliver
  // the records the transcript already rendered — only future appends.
  const dir = await mkdtemp(join(tmpdir(), 'mireof-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('a') + asstline('b') + userline('c'), 'utf8'); // seqs 1,2,3
  const mirror = createSessionMirror({ pollMs: 50 });
  const got = [];
  const sub = await mirror.subscribe('FRESH', f, (r) => got.push(r), 3); // cursor at EOF
  assert.ok(!got.some((r) => r.type === 'replay_gap'), 'no spurious replay_gap');
  assert.deepEqual(got.filter((r) => r.seq).map((r) => r.seq), [], 'no replayed records — cursor at end');
  // a future append IS delivered live
  await appendFile(f, userline('d'));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(got.filter((r) => r.seq).map((r) => r.seq), [4], 'future append delivered');
  sub.close(); mirror.close();
});

test('mirror: fresh tailer + lastSeq=0 → replays all existing records, no gap', async () => {
  // Guard against over-correcting: a cursor of 0 must still replay everything.
  const dir = await mkdtemp(join(tmpdir(), 'mirzero-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('a') + asstline('b') + userline('c'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 50 });
  const got = [];
  const sub = await mirror.subscribe('FRESH0', f, (r) => got.push(r), 0);
  assert.ok(!got.some((r) => r.type === 'replay_gap'), 'no gap on cursor 0');
  assert.deepEqual(got.filter((r) => r.seq).map((r) => r.seq), [1, 2, 3], 'all records replayed');
  sub.close(); mirror.close();
});

test('mirror: fresh tailer + lastSeq beyond EOF → replay_gap', async () => {
  // A genuine ahead-of-file cursor (truncation / stale resume) must still gap.
  const dir = await mkdtemp(join(tmpdir(), 'mirahead-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('a') + asstline('b') + userline('c'), 'utf8'); // up to seq 3
  const mirror = createSessionMirror({ pollMs: 50 });
  const got = [];
  const sub = await mirror.subscribe('AHEAD', f, (r) => got.push(r), 99);
  assert.equal(got[0]?.type, 'replay_gap', 'ahead-of-EOF cursor → replay_gap');
  sub.close(); mirror.close();
});

test('mirror: reconnect older than buffer → replay_gap; boundary replays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir2-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('a') + userline('b') + userline('c'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 50, bufferMax: 2 }); // keeps last 2 lines
  const warm = []; const s0 = await mirror.subscribe('S2', f, (r) => warm.push(r), 0);
  await new Promise(r => setTimeout(r, 200)); s0.close();
  // bufferStartSeq is now 2 (only lines 2,3 buffered). Reconnect with lastSeq=0 → gap.
  const got = []; const s1 = await mirror.subscribe('S2', f, (r) => got.push(r), 0);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(got[0].type, 'replay_gap');
  s1.close();
  // boundary: lastSeq = bufferStartSeq-1 = 1 → replays (no gap)
  const got2 = []; const s2 = await mirror.subscribe('S2', f, (r) => got2.push(r), 1);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!got2.some(r => r.type === 'replay_gap'));
  assert.equal(got2[0].seq, 2);
  s2.close(); mirror.close();
});

test('mirror: late subscriber replays from the buffer (no file re-read needed)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirlate-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('one') + asstline('two') + userline('three'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 50 });
  // first subscriber drains the file into the buffer, then leaves (buffer kept)
  const warm = []; const s0 = await mirror.subscribe('LATE', f, (r) => warm.push(r), 0);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(warm.length, 3); s0.close();
  // a late subscriber from cursor 0 replays all 3 buffered records
  const got = []; const s1 = await mirror.subscribe('LATE', f, (r) => got.push(r), 0);
  assert.deepEqual(got.map(r => r.seq), [1, 2, 3]); // replayed synchronously from buffer
  s1.close(); mirror.close();
});

test('mirror: truncation emits replay_gap to active subs AND to a stale-cursor reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirtrunc-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('a') + userline('b') + userline('c'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 40 });
  const live = []; const s = await mirror.subscribe('TR', f, (r) => live.push(r), 0);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(live.filter(r => r.seq).length, 3);
  // truncate + rewrite shorter → drain detects size<offset → reset + replay_gap
  await writeFile(f, userline('x'), 'utf8');
  await new Promise(r => setTimeout(r, 200));
  assert.ok(live.some(r => r.type === 'replay_gap'), 'active sub got replay_gap');
  s.close();
  // a reconnect carrying a pre-truncation cursor (ahead of the new short file) → gap
  const got = []; const s2 = await mirror.subscribe('TR', f, (r) => got.push(r), 99);
  assert.equal(got[0].type, 'replay_gap');
  s2.close(); mirror.close();
});

test('mirror: LRU-evicts an idle (zero-subscriber) tailer past maxTailers, never an active one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirlru-'));
  const mk = async (n, body) => { const f = join(dir, n + '.jsonl'); await writeFile(f, body, 'utf8'); return f; };
  const fa = await mk('a', userline('a1'));
  const fb = await mk('b', userline('b1'));
  const fc = await mk('c', userline('c1'));
  const mirror = createSessionMirror({ pollMs: 30, maxTailers: 2 });

  // A keeps an ACTIVE subscriber; B subscribes then leaves (idle, zero subs).
  const ga = []; const sa = await mirror.subscribe('A', fa, (r) => ga.push(r), 0);
  const gb = []; const sb = await mirror.subscribe('B', fb, (r) => gb.push(r), 0);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(ga.length, 1); assert.equal(gb.length, 1);
  sb.close(); // B is now idle (buffer kept, zero subs)

  // Subscribing C exceeds the cap of 2 → must evict the idle tailer (B), not A.
  const gc = []; const sc = await mirror.subscribe('C', fc, (r) => gc.push(r), 0);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(gc.length, 1);

  // A still has its buffer (was active, never evicted): a late cursor-0 reconnect
  // replays from the kept buffer, NOT a replay_gap.
  const ga2 = []; const sa2 = await mirror.subscribe('A', fa, (r) => ga2.push(r), 0);
  await new Promise(r => setTimeout(r, 60));
  assert.ok(!ga2.some(r => r.type === 'replay_gap'), 'active tailer A was not evicted');
  assert.equal(ga2[0].seq, 1);

  // B was evicted → its buffer is gone; revisiting rebuilds from the file head.
  const gb2 = []; const sb2 = await mirror.subscribe('B', fb, (r) => gb2.push(r), 0);
  await new Promise(r => setTimeout(r, 120));
  assert.ok(gb2.some(r => r.seq === 1), 'evicted B rebuilds its buffer from the file head');

  sa.close(); sa2.close(); sc.close(); sb2.close(); mirror.close();
});

test('mirror: two sessions on ONE instance keep independent buffers/cursors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miriso-'));
  const fa = join(dir, 'a.jsonl'); const fb = join(dir, 'b.jsonl');
  await writeFile(fa, userline('a1'), 'utf8');
  await writeFile(fb, userline('b1') + userline('b2'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 40 });
  const ga = []; const gb = [];
  const sa = await mirror.subscribe('A', fa, (r) => ga.push(r), 0);
  const sb = await mirror.subscribe('B', fb, (r) => gb.push(r), 0);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(ga.length, 1); assert.equal(ga[0].events[0].text, 'a1');
  assert.equal(gb.length, 2); assert.equal(gb[1].seq, 2);
  sa.close(); sb.close(); mirror.close();
});
