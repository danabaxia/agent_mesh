// test/session-model.test.js — turn-grouping model (Phase 7 LOCKED rules).
// Fixtures mirror REAL claude-session JSONL record shapes handled by
// gen_real_demo.py (the approved reference implementation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTurns, sniffType, extractImageRefs } from '../src/dashboard/public/session-model.js';

// ── fixture builders (real record shapes) ────────────────────────────────────
const u = (content, ts, extra = {}) =>
  ({ type: 'user', timestamp: ts, message: { role: 'user', content }, ...extra });
const a = (content, ts, extra = {}) =>
  ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content }, ...extra });
const txt = (t) => ({ type: 'text', text: t });
const tu = (name, input) => ({ type: 'tool_use', id: 'toolu_1', name, input });
const tr = (id) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] });

const T = (n) => `2026-06-11T10:0${n}:00.000Z`;

test('extractImageRefs finds md images, backticked filenames, and paths; dedupes; ignores non-images', () => {
  const text = [
    'Plot saved to `ht33_hourly_2026-06-11.png`.',                       // backticked bare filename (real bug case)
    'Also at C:\\AI\\agents_mesh\\my-mesh\\data-analyst\\deliverables\\2026-06-11\\ht33-hourly\\chart2.svg', // windows abs path
    '![trend](deliverables/2026-06-11/ht33-hourly/trend.png)',          // md image, deliverables-relative
    'See `ht33_hourly_2026-06-11.png` again',                            // duplicate → dedupe
    'and the data in `results.csv` plus code in `plot.py`.'              // non-images ignored
  ].join('\n');
  const refs = extractImageRefs(text);
  // order is scan-strategy-dependent (md images first); assert as a set
  assert.deepEqual(refs.map((r) => r.basename).sort(),
    ['chart2.svg', 'ht33_hourly_2026-06-11.png', 'trend.png']);
  const md = refs.find((r) => r.basename === 'trend.png');
  assert.equal(md.path, 'deliverables/2026-06-11/ht33-hourly/trend.png');
  const winAbs = refs.find((r) => r.basename === 'chart2.svg');
  assert.equal(winAbs.deliverablesRel, '2026-06-11/ht33-hourly/chart2.svg',
    'abs path under \\deliverables\\ maps to the deliverables-relative path');
  const bare = refs.find((r) => r.basename === 'ht33_hourly_2026-06-11.png');
  assert.equal(bare.deliverablesRel, null, 'bare filename has no mapping — resolved later by basename lookup');
});

test('extractImageRefs maps deliverables-relative md paths to deliverablesRel', () => {
  const refs = extractImageRefs('![x](deliverables/2026-06-11/t/x.png)');
  assert.equal(refs[0].deliverablesRel, '2026-06-11/t/x.png');
});

test('string-content user prompt starts a turn with qts/ats/answer', () => {
  const turns = groupTurns([
    u('hello world', T(0)),
    a([txt('hi there')], T(1))
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].q, 'hello world');
  assert.equal(turns[0].qts, T(0));
  assert.equal(turns[0].ats, T(1));
  assert.equal(turns[0].answer, 'hi there');
  assert.equal(turns[0].tools, 0);
  assert.deepEqual(turns[0].internals, []);
});

test('content-list text prompt starts a turn', () => {
  const turns = groupTurns([
    u([txt('list-shaped prompt')], T(0)),
    a([txt('answer')], T(1))
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].q, 'list-shaped prompt');
});

test('tool_result-only user record does NOT start a turn (tool echo)', () => {
  // no genuine prompt at all -> no turns, even with assistant output after
  assert.deepEqual(groupTurns([u([tr('toolu_1')], T(0)), a([txt('orphan')], T(1))]), []);
  // mid-turn tool echo does not break the trailing answer run
  const turns = groupTurns([
    u('Q', T(0)),
    a([txt('part one')], T(1)),
    u([tr('toolu_1')], T(2)),
    a([txt('part two')], T(3))
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].answer, 'part one\n\npart two');
});

test('NOISE-prefixed user texts are skipped', () => {
  const turns = groupTurns([
    u('Caveat: the messages below were generated…', T(0)),
    u('<command-name>/clear</command-name>', T(1)),
    u('<system-reminder>stuff</system-reminder>', T(2)),
    u('[Request interrupted by user]', T(3)),
    u('<local-command-caveat>…</local-command-caveat>', T(4)),
    a([txt('reply to nothing')], T(5))
  ]);
  assert.deepEqual(turns, []);
});

test('sidechain records (rec.isSidechain === true) are skipped entirely', () => {
  const turns = groupTurns([
    u('side prompt', T(0), { isSidechain: true }),
    u('real prompt', T(1)),
    a([txt('SIDE TEXT')], T(2), { isSidechain: true }),
    a([tu('Bash', { command: 'ls' })], T(3), { isSidechain: true }),
    a([txt('real answer')], T(4))
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].q, 'real prompt');
  assert.equal(turns[0].answer, 'real answer');
  assert.equal(turns[0].tools, 0);
  assert.deepEqual(turns[0].internals, []);
});

test('answer = TRAILING run of assistant texts; intermediate text before a tool_use is an internal', () => {
  const turns = groupTurns([
    u('Q', T(0)),
    a([txt('let me check')], T(1)),          // intermediate reply (followed by tool)
    a([tu('Bash', { command: 'ls' })], T(2)),
    a([txt('answer part 1')], T(3)),
    a([txt('answer part 2')], T(4))
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].answer, 'answer part 1\n\nanswer part 2');
  assert.equal(turns[0].ats, T(4));          // last answer block's record timestamp
  assert.equal(turns[0].tools, 1);
  assert.equal(turns[0].internals.length, 2); // excludes the answer run
  assert.deepEqual(turns[0].internals.map((e) => e.kind), ['reply', 'tool']);
  assert.equal(turns[0].internals[0].text, 'let me check');
  assert.match(turns[0].internals[1].text, /^Bash /);
});

test('multi-turn grouping: tools counted per turn, qts/ats per turn', () => {
  const turns = groupTurns([
    u('first question', T(0)),
    a([tu('Read', { file: 'a.js' }), txt('first answer')], T(1)),
    u('second question', T(2)),
    a([tu('Bash', { command: 'pwd' })], T(3)),
    a([tu('Grep', { pattern: 'x' })], T(4)),
    a([txt('second answer')], T(5))
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].tools, 1);
  assert.equal(turns[0].answer, 'first answer');
  assert.equal(turns[0].qts, T(0));
  assert.equal(turns[0].ats, T(1));
  assert.equal(turns[1].tools, 2);
  assert.equal(turns[1].answer, 'second answer');
  assert.equal(turns[1].qts, T(2));
  assert.equal(turns[1].ats, T(5));
});

test('title from QUESTION: md heading wins, else first line, md symbols stripped, <=70 chars', () => {
  const heading = groupTurns([u('intro line\n## Compare R4 hipot drift\nmore', T(0)), a([txt('a')], T(1))]);
  assert.equal(heading[0].title, 'Compare R4 hipot drift');
  const long = 'x'.repeat(100);
  const plain = groupTurns([u(`**bold** \`code\` # ${long}`, T(0)), a([txt('a')], T(1))]);
  assert.ok(!/[*`#]/.test(plain[0].title));
  assert.ok(plain[0].title.length <= 70);
  assert.ok(plain[0].title.startsWith('bold code'));
});

test('type = sniffType(answer): table/diff/chart/report', () => {
  const turns = groupTurns([
    u('Q', T(0)),
    a([txt('| a | b |\n| --- | --- |\n| 1 | 2 |')], T(1))
  ]);
  assert.equal(turns[0].type, 'table');
  assert.equal(sniffType('--- a/src/x.js\n+++ b/src/x.js\n@@ -1,2 +1,2 @@'), 'diff');
  assert.equal(sniffType('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'chart');
  assert.equal(sniffType('just some prose'), 'report');
});

test('turn whose answer is empty still yields a turn entry with answer:"" (consumer filters)', () => {
  const turns = groupTurns([
    u('Q with no final text', T(0)),
    a([tu('Bash', { command: 'ls' })], T(1))
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].answer, '');
  assert.equal(turns[0].ats, T(0)); // falls back to the prompt timestamp
  assert.equal(turns[0].tools, 1);
  assert.equal(turns[0].internals.length, 1);
});
