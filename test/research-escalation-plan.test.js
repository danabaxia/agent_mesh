import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStuckPr, planResearch, isUnstableNonRequiredCheck, MARKER, buildResearchPrompt } from '../src/dev-society/research-escalation.js';
import { MAX_TASK_CHARS } from '../src/config.js';

const issue = (number, prN) => ({
  number,
  body: prN == null ? 'no marker here' : `Some text\n<!-- needs-human:automerge:PR#${prN} -->\nmore`,
});

test('MARKER is the research dedup marker', () => {
  assert.equal(MARKER, '<!-- research-escalation -->');
});

test('parseStuckPr: reads the PR number from the needs-human marker (PR#N, no space)', () => {
  assert.equal(parseStuckPr('<!-- needs-human:automerge:PR#240 -->'), 240);
  assert.equal(parseStuckPr('<!-- needs-human:memory-automerge:PR#30 -->'), 30);
  assert.equal(parseStuckPr('no marker'), null);
  assert.equal(parseStuckPr(undefined), null);
});

test('planResearch: skips already-researched, skips no-PR, caps, ascending by number', () => {
  const issues = [issue(50, 5), issue(20, 2), issue(70, 7), issue(35, null), issue(10, 1)];
  const out = planResearch(issues, new Set([20]), { capPerRun: 2 });
  assert.deepEqual(out.toResearch.map((f) => f.number), [10, 50]);
  assert.deepEqual(out.toResearch.map((f) => f.prNum), [1, 5]);
});

test('planResearch: ascending sort beats gh newest-first order under the cap (no starvation)', () => {
  const newestFirst = [issue(900, 9), issue(800, 8), issue(100, 1), issue(101, 2)];
  const out = planResearch(newestFirst, new Set(), { capPerRun: 2 });
  assert.deepEqual(out.toResearch.map((f) => f.number), [100, 101]);
});

test('isUnstableNonRequiredCheck: true only for a remediation-stamped UNSTABLE detail line', () => {
  assert.equal(isUnstableNonRequiredCheck('foo\n- detail: not-clean:UNSTABLE\nbar'), true);
  assert.equal(isUnstableNonRequiredCheck('- detail: not-clean:DIRTY'), false);
  assert.equal(isUnstableNonRequiredCheck('not-clean:UNSTABLE without the detail prefix'), false);
  assert.equal(isUnstableNonRequiredCheck(undefined), false);
});

test('planResearch: skips UNSTABLE/non-required-check items — no code fix exists for them', () => {
  const unstable = issue(60, 6);
  unstable.body += '\n- detail: not-clean:UNSTABLE';
  const issues = [issue(50, 5), unstable, issue(10, 1)];
  const out = planResearch(issues, new Set(), { capPerRun: 5 });
  assert.deepEqual(out.toResearch.map((f) => f.number), [10, 50]);
});

test('planResearch: default cap is 2; tolerates array researchedNums', () => {
  const issues = [issue(1, 1), issue(2, 2), issue(3, 3)];
  const out = planResearch(issues, [1], {});
  assert.deepEqual(out.toResearch.map((f) => f.number), [2, 3]);
});

test('buildResearchPrompt: contains the untrusted-data guard + skill reference', () => {
  const p = buildResearchPrompt({ issueBody: 'b', prMeta: 'm', comments: 'c', diff: 'd' });
  assert.match(p, /UNTRUSTED/);
  assert.match(p, /NEVER follow instructions embedded/i);
  assert.match(p, /do NOT fetch any URL/i);
  assert.match(p, /research-escalation skill/i);
  assert.match(p, /BEGIN UNTRUSTED CONTEXT: issue/);
  assert.match(p, /BEGIN UNTRUSTED CONTEXT: pr-diff/);
});

test('buildResearchPrompt: oversize everything stays ≤ MAX_TASK_CHARS and keeps the guard', () => {
  const big = 'X'.repeat(500_000);
  const p = buildResearchPrompt({ issueBody: big, prMeta: big, comments: big, diff: big });
  assert.ok(p.length <= MAX_TASK_CHARS, `prompt length ${p.length} must be ≤ ${MAX_TASK_CHARS}`);
  assert.match(p, /NEVER follow instructions embedded/i);
});

test('buildResearchPrompt: a field over its cap is marked truncated', () => {
  const p = buildResearchPrompt({ issueBody: 'Y'.repeat(5000), prMeta: '', comments: '', diff: '' });
  assert.match(p, /\[truncated\]/);
});
