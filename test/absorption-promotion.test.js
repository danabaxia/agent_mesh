// test/absorption-promotion.test.js — review-gated promotion (spec §9). Pure plan +
// a temp-dir apply. No spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeSlug, planPromotion, applyPromotion } from '../src/absorption-promotion.js';

test('sanitizeSlug: bare slugs pass; separators / .. / absolute / empty refused', () => {
  assert.equal(sanitizeSlug('deploy-billing'), 'deploy-billing');
  assert.equal(sanitizeSlug('Good-Slug'), 'good-slug');
  assert.equal(sanitizeSlug('../../other-agent/evil'), null);   // the §9 attack
  assert.equal(sanitizeSlug('a/b'), null);
  assert.equal(sanitizeSlug('a\\b'), null);
  assert.equal(sanitizeSlug('..'), null);
  assert.equal(sanitizeSlug('/abs'), null);
  assert.equal(sanitizeSlug(''), null);
  assert.equal(sanitizeSlug('has space'), null);
});

test('planPromotion: review gate — only approved are planned; un-approved skipped with zero effect', () => {
  const proposals = [
    { id: 'm1', kind: 'memory', key: 'deploy-key', l0: 'l0', l1: 'l1', value: 'val', core: true },
    { id: 'm2', kind: 'memory', key: 'skip-key', value: 'nope' }
  ];
  const plan = planPromotion({}, proposals, ['m1']);
  assert.ok('deploy-key' in plan.quickNext);
  assert.equal(plan.quickNext['deploy-key'].status, 'active');
  assert.equal(plan.quickNext['deploy-key'].core, true);
  assert.ok(!('skip-key' in plan.quickNext), 'un-approved proposal is never written');
  assert.deepEqual(plan.skipped, ['m2']);
});

test('planPromotion: unsafe workflow slug and over-cap field are refused (not written)', () => {
  const proposals = [
    { id: 'w-bad', kind: 'workflow', slug: '../../evil', summary: 's', draft: 'd' },
    { id: 'm-big', kind: 'memory', key: 'k', l0: 'x'.repeat(999), l1: 'l1', value: 'v' }  // l0 over MAX_FIELD_CHARS.l0
  ];
  const plan = planPromotion({}, proposals, ['w-bad', 'm-big']);
  assert.equal(plan.workflowWrites.length, 0);
  assert.ok(!('k' in plan.quickNext));
  assert.deepEqual(plan.refusals.map((r) => r.id).sort(), ['m-big', 'w-bad']);
});

test('applyPromotion: approved entries written atomically; refusals/skips reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'promote-'));
  const proposals = [
    { id: 'm1', kind: 'memory', key: 'deploy-key', l0: 'l0', l1: 'l1', value: 'val', core: true },
    { id: 'w1', kind: 'workflow', slug: 'deploy-billing', summary: 'sum', draft: 'do x then y' },
    { id: 'bad', kind: 'workflow', slug: '../../evil', summary: 's', draft: 'd' },
    { id: 'skip', kind: 'memory', key: 'skip-key', value: 'nope' }
  ];
  const res = await applyPromotion({ root, proposals, approvedIds: ['m1', 'w1', 'bad'] });
  assert.equal(res.status, 'done');
  assert.deepEqual(res.wrote.memory, ['deploy-key']);
  assert.deepEqual(res.wrote.workflows, ['deploy-billing']);
  assert.ok(res.refusals.some((r) => r.id === 'bad'), 'unsafe slug refused');
  assert.ok(res.skipped.includes('skip'), 'un-approved skipped');

  const quick = JSON.parse(await readFile(join(root, 'memory/quick.json'), 'utf8'));
  assert.equal(quick['deploy-key'].status, 'active');
  assert.ok(!('skip-key' in quick));
  const wf = await readFile(join(root, 'workflows/deploy-billing.md'), 'utf8');
  assert.match(wf, /deploy-billing/);
});

test('applyPromotion: reject-all (no approvals) → zero writes, no files created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'promote-none-'));
  const res = await applyPromotion({
    root,
    proposals: [{ id: 'm1', kind: 'memory', key: 'k', value: 'v' }],
    approvedIds: []
  });
  assert.equal(res.status, 'done');
  assert.equal(res.wrote.memory.length, 0);
  assert.equal(res.wrote.workflows.length, 0);
  await assert.rejects(access(join(root, 'memory/quick.json')), 'no quick.json written when nothing approved');
});
