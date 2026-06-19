// test/report-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderModel, dailyMarker, findDatedCommentId } from '../src/report/render.js';

const REPORT = {
  date: '2026-06-18',
  window: { fromISO: '2026-06-18T00:00:00.000Z', toISO: '2026-06-19T00:00:00.000Z' },
  prs: { opened: [{ number: 1, title: 'a', url: 'u' }], merged: [], closed: [], openNow: 7 },
  issues: { opened: [], closed: [], openByLabel: { approved: 3, blocked: 1 } },
  tokens: {
    local: { input: 170, output: 17, cacheRead: 0, cacheCreation: 0, costUsd: 0.85, turns: 5, runs: 3, byRoute: {} },
    ci: { input: 1500, output: 150, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 13, runs: 2, uncaptured: 1, byWorkflow: {} },
    total: { input: 1670, output: 167, cacheRead: 0, cacheCreation: 0, costUsd: 0.85, turns: 18 },
  },
};

test('dailyMarker is a stable HTML comment keyed by date', () => {
  assert.equal(dailyMarker('2026-06-18'), '<!-- daily-report:2026-06-18 -->');
});

test('renderMarkdown embeds the marker, the date, and the $0 footnote', () => {
  const md = renderMarkdown(REPORT);
  assert.ok(md.includes('<!-- daily-report:2026-06-18 -->'));
  assert.ok(md.includes('Daily Mesh Report — 2026-06-18'));
  assert.ok(md.includes('open now 7'));
  assert.ok(md.includes('approved 3'));
  assert.ok(/subscription auth reports \$0/i.test(md));
  assert.ok(md.includes('1 uncaptured'));
});

test('findDatedCommentId returns the id of the comment carrying the date marker', () => {
  const comments = [
    { id: 11, body: 'unrelated' },
    { id: 22, body: `prefix\n${dailyMarker('2026-06-18')}\nstuff` },
  ];
  assert.equal(findDatedCommentId(comments, '2026-06-18'), 22);
  assert.equal(findDatedCommentId(comments, '2026-06-17'), null);
});

test('renderModel returns a JSON-able object (no markdown)', () => {
  const m = renderModel(REPORT);
  assert.equal(m.date, '2026-06-18');
  assert.equal(m.tokens.total.input, 1670);
});
