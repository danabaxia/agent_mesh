import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisions, searchDecisions } from '../examples/agent-b/tools/memory/server.mjs';

const SAMPLE_DECISIONS = `# Past decisions

- 2026-05-18 — adopted search_books MCP.
  Some extra details on next line.
- 2026-06-01 — lib/strings.js is for string helpers.
- 2026-06-03 — citation style rules.
`;

test('parseDecisions correctly extracts bullet points and merges multiline entries', () => {
  const bullets = parseDecisions(SAMPLE_DECISIONS);
  assert.equal(bullets.length, 3);
  assert.equal(bullets[0], '- 2026-05-18 — adopted search_books MCP. Some extra details on next line.');
  assert.equal(bullets[1], '- 2026-06-01 — lib/strings.js is for string helpers.');
  assert.equal(bullets[2], '- 2026-06-03 — citation style rules.');
});

test('searchDecisions matches query case-insensitively', () => {
  const bullets = parseDecisions(SAMPLE_DECISIONS);
  const hits = searchDecisions(bullets, 'strings');
  assert.deepEqual(hits, ['- 2026-06-01 — lib/strings.js is for string helpers.']);
});

test('searchDecisions matches date query', () => {
  const bullets = parseDecisions(SAMPLE_DECISIONS);
  const hits = searchDecisions(bullets, '2026-06-03');
  assert.deepEqual(hits, ['- 2026-06-03 — citation style rules.']);
});

test('searchDecisions returns all entries on empty/blank query', () => {
  const bullets = parseDecisions(SAMPLE_DECISIONS);
  const hits = searchDecisions(bullets, '   ');
  assert.equal(hits.length, 3);
});

test('searchDecisions returns empty list on no match', () => {
  const bullets = parseDecisions(SAMPLE_DECISIONS);
  const hits = searchDecisions(bullets, 'nonexistent');
  assert.deepEqual(hits, []);
});
