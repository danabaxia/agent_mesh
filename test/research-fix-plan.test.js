import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResearchFix, researchFixPrompt, FIX_MARKER, DIAG_MARKER } from '../src/dev-society/research-fix.js';

const iss = (number, prN, { diagnosis = 'DX', attempted = false } = {}) => ({
  number, title: `t${number}`,
  body: prN == null ? 'no marker' : `<!-- needs-human:automerge:PR#${prN} -->`,
  diagnosis, attempted,
});

test('markers', () => {
  assert.equal(FIX_MARKER, '<!-- research-fix -->');
  assert.equal(DIAG_MARKER, '<!-- research-escalation -->');
});

test('planResearchFix: picks diagnosed+unattempted with a PR marker, ascending, capped', () => {
  const issues = [iss(50, 5), iss(20, 2), iss(70, 7, { attempted: true }), iss(35, null), iss(10, 1, { diagnosis: null })];
  const out = planResearchFix(issues, { capPerRun: 1 });
  assert.deepEqual(out.toFix.map((f) => f.number), [20]);
  assert.equal(out.toFix[0].prNum, 2);
  assert.equal(out.toFix[0].diagnosis, 'DX');
});

test('planResearchFix: default cap 1', () => {
  const out = planResearchFix([iss(1, 1), iss(2, 2)], {});
  assert.equal(out.toFix.length, 1);
  assert.equal(out.toFix[0].number, 1);
});

test('planResearchFix: skips UNSTABLE/non-required-check items even when diagnosed — no code fix exists for them', () => {
  const unstable = iss(20, 2);
  unstable.body += '\n- detail: not-clean:UNSTABLE';
  const out = planResearchFix([unstable, iss(10, 1)], { capPerRun: 5 });
  assert.deepEqual(out.toFix.map((f) => f.number), [10]);
});

test('researchFixPrompt: includes issue + diagnosis-as-untrusted-strategy + minimal/suite-green rule', () => {
  const p = researchFixPrompt({ number: 9, title: 'fix X' }, 'do the thing');
  assert.match(p, /#9/);
  assert.match(p, /fix X/);
  assert.match(p, /RECOMMENDED STRATEGY/i);
  assert.match(p, /untrusted/i);
  assert.match(p, /test suite must pass|suite must pass/i);
  assert.match(p, /do the thing/);
});
