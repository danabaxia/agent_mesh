// test/escalation.test.js — pure logic for surfacing stale-stuck PRs as needs-triage.
// Spec: docs/superpowers/specs/2026-06-19-mesh-self-healing-gaps-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { prNeedsEscalation, escalationTitle, escalationBody, parsePrNumber } from '../src/automerge/escalation.js';

const NOW = 2_000_000_000_000;            // fixed "now"
const old = new Date(NOW - 4 * 3600_000).toISOString();   // 4h ago (> 3h stale)
const fresh = new Date(NOW - 10 * 60_000).toISOString();  // 10 min ago
const base = { number: 7, title: 't', url: 'u', isDraft: false, isCrossRepository: false, labels: [], updatedAt: old };
const esc = (pr) => prNeedsEscalation({ ...base, ...pr }, { now: NOW, staleMs: 3 * 3600_000 });

test('escalates each stuck state when stale', () => {
  assert.equal(esc({ mergeStateStatus: 'DIRTY' }), true, 'DIRTY');
  assert.equal(esc({ mergeStateStatus: 'UNKNOWN' }), true, 'UNKNOWN');
  assert.equal(esc({ mergeStateStatus: 'UNSTABLE' }), true, 'UNSTABLE (failing/never-green checks)');
  assert.equal(esc({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }), true, 'CHANGES_REQUESTED');
  assert.equal(esc({ mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED' }), true, 'CLEAN but unreviewed (no-review orphan)');
  assert.equal(esc({ mergeStateStatus: 'CLEAN', reviewDecision: null }), true, 'CLEAN, no review');
});

test('does NOT escalate healthy / intentionally-held / in-flight states', () => {
  assert.equal(esc({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }), false, 'will auto-merge');
  assert.equal(esc({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }), false, 'BLOCKED = intentional hold (blocked-by-issue)');
  assert.equal(esc({ mergeStateStatus: 'BEHIND', reviewDecision: 'APPROVED' }), false, 'BEHIND = mergefix territory');
});

test('fresh (within staleMs) is never escalated — gives repair loops time', () => {
  assert.equal(prNeedsEscalation({ ...base, mergeStateStatus: 'DIRTY', updatedAt: fresh }, { now: NOW, staleMs: 3 * 3600_000 }), false);
});

test('excludes drafts, forks, and memory:promote PRs', () => {
  assert.equal(esc({ mergeStateStatus: 'DIRTY', isDraft: true }), false, 'draft');
  assert.equal(esc({ mergeStateStatus: 'DIRTY', isCrossRepository: true }), false, 'fork');
  assert.equal(esc({ mergeStateStatus: 'DIRTY', labels: [{ name: 'memory:promote' }] }), false, 'memory pipeline owns these');
});

test('fail-closed on garbage', () => {
  assert.equal(prNeedsEscalation(null, { now: NOW, staleMs: 1 }), false);
  assert.equal(prNeedsEscalation({}, { now: NOW, staleMs: 1 }), false);
});

test('title is dedup-stable; parsePrNumber round-trips it', () => {
  const t = escalationTitle({ ...base, number: 42, mergeStateStatus: 'DIRTY' });
  assert.match(t, /PR #42/);
  assert.equal(parsePrNumber(t), 42);
  assert.equal(parsePrNumber('needs-triage: PR #100 unlabelled and stuck'), 100, 'matches the janitor title shape too');
  assert.equal(parsePrNumber('no number here'), null);
});

test('body carries PR url + state context', () => {
  const b = escalationBody({ ...base, number: 9, url: 'https://x/9', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' });
  assert.match(b, /https:\/\/x\/9/);
  assert.match(b, /DIRTY/);
  assert.match(b, /CHANGES_REQUESTED/);
});
