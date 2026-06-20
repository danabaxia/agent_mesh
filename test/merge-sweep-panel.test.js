import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeSweep } from '../src/dashboard/public/merge-sweep-render.js';

test('lists checkpoints + flagged items with state chips and numeric-ref links', () => {
  const html = renderMergeSweep({ available: true, stale: false, summary: { ok: 1, flagged: 1, errors: 0 },
    checkpoints: [{ name: 'automerge', status: 'flagged', items: [{ ref: 'PR#12', number: 12, state: 'would-merge', detail: 'ok', ageRuns: 2 }] }] });
  assert.match(html, /automerge/);
  assert.match(html, /would-merge/);
  assert.match(html, /\/pull\/12/);
  assert.match(html, /2 runs?/);
});

test('escapes hostile PR titles (no raw HTML)', () => {
  const html = renderMergeSweep({ available: true, stale: false, summary: {}, checkpoints: [
    { name: 'automerge', status: 'flagged', items: [{ ref: 'PR#1', number: 1, state: 'held', detail: '<img src=x onerror=alert(1)>', ageRuns: 1 }] }] });
  assert.ok(!html.includes('<img src=x'), 'detail must be escaped');
  assert.match(html, /&lt;img/);
});

test('available:false → placeholder', () => {
  assert.match(renderMergeSweep({ available: false }), /no merge-sweep report/i);
});
