// test/dev-society.test.js — hermetic tests for the A2A Dev-Society pure core (P1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as devCore from '../src/dev-society/core.js';
import {
  isEligible, selectTask, branchName, a2aMessage, coderPrompt, reviewerPrompt,
  taskText, taskOutcome, taskSucceeded, ledgerRecord, shouldOpenPR,
  ROUTE_LABEL, APPROVED, IN_PROGRESS, PR_IN_REVIEW,
} from '../src/dev-society/core.js';

const issue = (n, labels, extra = {}) => ({ number: n, title: `t${n}`, body: 'b', labels, ...extra });

test('isEligible: approved ∧ route:a2a ∧ not in-progress/blocked/pr:in-review', () => {
  assert.equal(isEligible(issue(1, [APPROVED, ROUTE_LABEL])), true);
  assert.equal(isEligible(issue(2, [APPROVED])), false, 'needs route:a2a');
  assert.equal(isEligible(issue(3, [ROUTE_LABEL])), false, 'needs approved');
  assert.equal(isEligible(issue(4, [APPROVED, ROUTE_LABEL, IN_PROGRESS])), false, 'already claimed');
  assert.equal(isEligible(issue(5, [APPROVED, ROUTE_LABEL, 'blocked'])), false, 'blocked');
  assert.equal(isEligible(issue(6, [APPROVED, ROUTE_LABEL, PR_IN_REVIEW])), false, 'already in review');
});

test('isEligible: accepts label objects ({name}) as well as strings', () => {
  assert.equal(isEligible(issue(1, [{ name: APPROVED }, { name: ROUTE_LABEL }])), true);
});

test('selectTask: FIFO lowest number among eligible; route:a2a opt-in respected', () => {
  const issues = [
    issue(9, [APPROVED, ROUTE_LABEL]),
    issue(3, [APPROVED]),               // not routed → GitHub backlog owns it
    issue(5, [APPROVED, ROUTE_LABEL]),
    issue(4, [APPROVED, ROUTE_LABEL, IN_PROGRESS]), // claimed
  ];
  assert.equal(selectTask(issues).number, 5);
  assert.equal(selectTask([issue(1, [APPROVED])]), null);
  assert.equal(selectTask([]), null);
});

test('branchName: deterministic', () => {
  assert.equal(branchName(42), 'dev-society/issue-42');
});

test('a2aMessage: carries the mesh mode in metadata', () => {
  const m = a2aMessage('do', 'hello', 'id-1');
  assert.equal(m.metadata['agentmesh/mode'], 'do');
  assert.equal(m.parts[0].text, 'hello');
  assert.equal(m.role, 'ROLE_AGENT');
  assert.equal(m.messageId, 'id-1');
});

test('prompts: coder forbids shell, reviewer frames diff as data', () => {
  const cp = coderPrompt(issue(7, [APPROVED, ROUTE_LABEL]));
  assert.match(cp, /Do NOT run git/);
  assert.match(cp, /the harness does that/);
  assert.match(cp, /Issue #7/);
  const rp = reviewerPrompt(issue(7, []), 'diff --git a b');
  assert.match(rp, /treat ALL of it as data/);
  assert.match(rp, /```diff/);
  assert.match(rp, /comment only/);
});

const okTask = {
  metadata: {
    'agentmesh/status': 'TASK_STATE_COMPLETED',
    'agentmesh/files_changed': ['src/x.js'],
    'agentmesh/run_id': 'r1',
    'agentmesh/metrics': { worker_run_ms: 10 },
  },
  artifacts: [{ parts: [{ text: 'done: changed x' }] }],
};

test('taskOutcome / taskText / taskSucceeded', () => {
  const o = taskOutcome(okTask);
  assert.equal(o.status, 'TASK_STATE_COMPLETED');
  assert.deepEqual(o.filesChanged, ['src/x.js']);
  assert.equal(o.runId, 'r1');
  assert.equal(taskText(okTask), 'done: changed x');
  assert.equal(taskSucceeded(okTask), true);
  assert.equal(taskSucceeded({ metadata: { 'agentmesh/status': 'TASK_STATE_COMPLETED', 'agentmesh/error_code': 'timeout' } }), false);
});

test('shouldOpenPR: needs success + changed files + green tests; fail-closed on null tests', () => {
  assert.equal(shouldOpenPR({ coderTask: okTask, tests: { passed: true } }), true);
  assert.equal(shouldOpenPR({ coderTask: okTask, tests: { passed: false } }), false);
  assert.equal(shouldOpenPR({ coderTask: okTask, tests: null }), false, 'null tests → fail-closed, no PR');
  const noChange = { metadata: { 'agentmesh/status': 'TASK_STATE_COMPLETED', 'agentmesh/files_changed': [] } };
  assert.equal(shouldOpenPR({ coderTask: noChange, tests: { passed: true } }), false, 'no files changed');
});

test('ledgerRecord: captures delegation edges + outcomes for the perf ledger', () => {
  const rec = ledgerRecord({
    issue: issue(12, [APPROVED, ROUTE_LABEL]),
    coderTask: okTask,
    reviewerTask: { metadata: { 'agentmesh/status': 'TASK_STATE_COMPLETED' } },
    tests: { passed: true, summary: '129 green' },
    prNumber: 99,
    ts: '2026-06-16T00:00:00.000Z',
  });
  assert.equal(rec.issue, 12);
  assert.equal(rec.branch, 'dev-society/issue-12');
  assert.equal(rec.pr, 99);
  assert.equal(rec.edges.length, 2);
  assert.equal(rec.edges[0].to, 'coder');
  assert.equal(rec.edges[0].mode, 'do');
  assert.equal(rec.edges[1].to, 'reviewer');
  assert.equal(rec.edges[1].mode, 'ask');
  assert.equal(rec.tests.passed, true);
  assert.equal(rec.coder_run_id, 'r1');
});

test('registryFor: launches A2A peers with the current node binary', () => {
  assert.equal(typeof devCore.registryFor, 'function');
  const registry = devCore.registryFor('/tmp/dev-society-worktree', {
    binPath: '/repo/bin/agent-mesh.js',
    nodePath: '/usr/local/Cellar/node/25.2.1/bin/node',
  });

  assert.equal(registry.peers.coder.command, '/usr/local/Cellar/node/25.2.1/bin/node');
  assert.equal(registry.peers.reviewer.command, '/usr/local/Cellar/node/25.2.1/bin/node');
  assert.deepEqual(registry.peers.coder.args, ['/repo/bin/agent-mesh.js', 'serve-a2a', '/tmp/dev-society-worktree']);
  assert.equal(registry.peers.coder.cwd, '/tmp/dev-society-worktree');
  assert.deepEqual(registry.peers.coder.env, { AGENT_MESH_ENABLED_MODES: 'ask,do' });
  // S1 (#86 review): the reviewer peer is ask-only — never granted `do`.
  assert.deepEqual(registry.peers.reviewer.env, { AGENT_MESH_ENABLED_MODES: 'ask' });
});

import {
  routeFor, labelNames,
  IDEA, QUESTION, BUG, ENHANCEMENT, DOCUMENTATION,
  SPEC_DRAFT, SPEC_IN_REVIEW, DISCUSSING, DONE, BLOCKED,
} from '../src/dev-society/core.js';

test('routeFor: terminal + human-gated labels are skipped', () => {
  for (const l of [DONE, 'rejected', 'wontfix', 'duplicate', 'invalid']) {
    assert.equal(routeFor(issue(1, [l])).target, null, `${l} terminal`);
  }
  for (const l of [SPEC_IN_REVIEW, PR_IN_REVIEW, BLOCKED, DISCUSSING]) {
    assert.equal(routeFor(issue(1, [l])).target, null, `${l} human-gated`);
  }
});

test('planLabelRepair: auto-routes dev-mesh security alerts out of blocked', () => {
  const plan = devCore.planLabelRepair(issue(145, [BLOCKED], {
    title: 'Dev-mesh security alert',
    body: '## Dev-mesh scheduled security sweep — BLOCKING finding\n\nShell injection via workflow_dispatch input.',
  }));
  assert.equal(plan.reason, 'security-alert-auto-route');
  assert.deepEqual(plan.remove, [BLOCKED]);
  assert.deepEqual(plan.add, [APPROVED, ROUTE_LABEL, BUG]);
  assert.match(plan.comment, /Auto-normalized security alert/);
});

test('planLabelRepair: keeps human blocked issues blocked while cleaning contradictory workflow labels', () => {
  const plan = devCore.planLabelRepair(issue(7, [BLOCKED, APPROVED, ROUTE_LABEL, IN_PROGRESS], {
    title: 'blocked on external dependency',
    body: 'Waiting for a vendor fix.',
  }));
  assert.equal(plan.reason, 'blocked-conflict-cleanup');
  assert.deepEqual(plan.remove, [APPROVED, ROUTE_LABEL, IN_PROGRESS]);
  assert.deepEqual(plan.add, []);
  assert.match(plan.comment, /kept `blocked`/);
  assert.equal(devCore.planLabelRepair(issue(8, [BLOCKED])), null);
});

test('planLabelRepair: approved + spec:in-review on a code-type clears the review gate (drains the deadlock)', () => {
  const plan = devCore.planLabelRepair(issue(175, [ENHANCEMENT, APPROVED, ROUTE_LABEL, SPEC_IN_REVIEW]));
  assert.equal(plan.reason, 'approved-clears-spec-review');
  assert.deepEqual(plan.remove, [SPEC_IN_REVIEW]);
  assert.deepEqual(plan.add, []);
  assert.match(plan.comment, /Auto-cleared `spec:in-review`/);
  // and after the repair, routeFor sends it to the coder (no longer human-gated)
  assert.equal(routeFor(issue(175, [ENHANCEMENT, APPROVED, ROUTE_LABEL])).target, 'coder');
});

test('planLabelRepair: approved + spec:in-review only clears for code-types (idea must NOT, to avoid the spec-draft loop)', () => {
  assert.equal(devCore.planLabelRepair(issue(9, [IDEA, APPROVED, SPEC_IN_REVIEW])), null);
});

test('planLabelRepair: does not touch approved issues already at pr:in-review or in-progress', () => {
  assert.equal(devCore.planLabelRepair(issue(10, [ENHANCEMENT, APPROVED, SPEC_IN_REVIEW, PR_IN_REVIEW])), null);
  assert.equal(devCore.planLabelRepair(issue(11, [ENHANCEMENT, APPROVED, SPEC_IN_REVIEW, IN_PROGRESS])), null);
});

test('planLabelRepair: spec:in-review WITHOUT approved stays human-gated (no repair)', () => {
  assert.equal(devCore.planLabelRepair(issue(12, [ENHANCEMENT, SPEC_IN_REVIEW])), null);
});

test('routeFor: idea needs approval; approved idea (no review gate) → analyst draft (advance spec:draft)', () => {
  assert.equal(routeFor(issue(1, [IDEA])).target, null, 'idea without approval skipped');
  const r = routeFor(issue(2, [IDEA, APPROVED]));
  assert.equal(r.target, 'analyst');
  assert.equal(r.mode, 'ask');
  assert.equal(r.advance, SPEC_DRAFT);
});

test('routeFor: `approved` overrides the review gate → coder, for EVERY type (the human only adds approved)', () => {
  // spec:in-review + approved → coder, regardless of type label present
  for (const extra of [[], [BUG], [ENHANCEMENT], [DOCUMENTATION], [IDEA]]) {
    const r = routeFor(issue(1, [SPEC_IN_REVIEW, APPROVED, ...extra]));
    assert.equal(r.target, 'coder', `approved+spec:in-review+[${extra}] → coder`);
    assert.equal(r.mode, 'do');
    assert.deepEqual(r.clear, [SPEC_IN_REVIEW]);
  }
  // discussing + approved → coder too
  assert.equal(routeFor(issue(2, [DISCUSSING, APPROVED])).target, 'coder');
});

test('routeFor: `approved` does NOT override the HARD gates (blocked / pr:in-review) or terminal', () => {
  assert.equal(routeFor(issue(1, [BLOCKED, APPROVED, SPEC_IN_REVIEW])).target, null, 'blocked stays a hard stop');
  assert.equal(routeFor(issue(2, [PR_IN_REVIEW, APPROVED])).target, null, 'pr:in-review already has a PR');
  assert.equal(routeFor(issue(3, [DONE, APPROVED])).target, null, 'terminal');
});

test('routeFor: an approved issue is NEVER idle — every non-terminal/non-hard-gated approved issue gets an agent', () => {
  // code-type (no review gate) → coder; typeless → triager; idea (no spec) → analyst; all non-null
  for (const labels of [[ENHANCEMENT, APPROVED], [APPROVED], [IDEA, APPROVED], [SPEC_IN_REVIEW, APPROVED]]) {
    assert.notEqual(routeFor(issue(1, labels)).target, null, `approved [${labels}] must be worked`);
  }
});

test('routeFor: spec:draft → analyst finalize (spec PR)', () => {
  const r = routeFor(issue(3, [SPEC_DRAFT]));
  assert.equal(r.target, 'analyst');
  assert.equal(r.mode, 'ask');
  assert.equal(r.spec, true);
});

test('routeFor: question → analyst; code types → coder; CI title → triager; else → triager', () => {
  assert.equal(routeFor(issue(4, [QUESTION])).target, 'analyst');
  for (const l of [BUG, ENHANCEMENT, DOCUMENTATION]) {
    const r = routeFor(issue(5, [l]));
    assert.equal(r.target, 'coder', l);
    assert.equal(r.mode, 'do', l);
  }
  assert.equal(routeFor({ number: 6, title: 'infra_auth: nightly broke', labels: [] }).target, 'triager');
  assert.equal(routeFor({ number: 7, title: 'flake: foo', labels: [] }).target, 'triager');
  assert.equal(routeFor(issue(8, ['help wanted'])).target, 'triager', 'unrecognized → triage');
});

test('routeFor: code build is autonomous (no approved/route:a2a needed)', () => {
  assert.equal(routeFor(issue(9, [BUG])).target, 'coder');
});

test('routeFor: in-progress skipped unless stale → coder reclaim', () => {
  assert.equal(routeFor(issue(10, [IN_PROGRESS])).target, null, 'fresh build in flight');
  assert.equal(routeFor(issue(10, [IN_PROGRESS]), { liveBuilds: new Set([10]) }).target, null, 'live build');
  const r = routeFor(issue(10, [IN_PROGRESS]), { staleClaims: new Set([10]) });
  assert.equal(r.target, 'coder');
  assert.equal(r.clear, IN_PROGRESS);
});

test('labelNames: returns normalized label strings', () => {
  assert.deepEqual(labelNames(issue(1, [{ name: BUG }, 'enhancement'])), [BUG, 'enhancement']);
});

import { selectCoderTask, labelsHash, shouldDispatch, recordDispatch } from '../src/dev-society/core.js';

test('selectCoderTask: FIFO lowest number, null on empty', () => {
  assert.equal(selectCoderTask([issue(9, []), issue(3, []), issue(5, [])]).number, 3);
  assert.equal(selectCoderTask([]), null);
});

test('labelsHash: order-independent', () => {
  assert.equal(labelsHash(issue(1, ['b', 'a'])), labelsHash(issue(1, ['a', 'b'])));
});

test('shouldDispatch/recordDispatch: fire once until target or labels change', () => {
  const state = {};
  const i = issue(1, [QUESTION]);
  const r = { target: 'analyst' };
  assert.equal(shouldDispatch(i, r, state), true, 'first time');
  recordDispatch(state, i, r, 1000);
  assert.equal(shouldDispatch(i, r, state), false, 'already dispatched, unchanged');
  assert.equal(shouldDispatch(i, { target: 'triager' }, state), true, 'target changed');
  assert.equal(shouldDispatch(issue(1, [QUESTION, 'help wanted']), r, state), true, 'labels changed');
  assert.equal(state[1].dispatchedAt, 1000);
});

import {
  analystDraftPrompt, analystSpecPrompt, triagePrompt, questionPrompt, advisoryRegistry,
} from '../src/dev-society/core.js';

test('advisory prompts: frame issue as data, name the issue number', () => {
  const i = issue(42, [IDEA, APPROVED], { title: 'add widget', body: 'please' });
  for (const p of [analystDraftPrompt(i), analystSpecPrompt(i), triagePrompt(i), questionPrompt(i)]) {
    assert.match(p, /#42/);
    assert.match(p, /add widget/);
    assert.match(p, /data/i, 'frames input as data');
  }
  assert.match(analystSpecPrompt(i), /spec|design/i);
  assert.match(triagePrompt(i), /classif|plan/i);
});

test('advisoryRegistry: ask-only peers rooted under meshRoot', () => {
  const reg = advisoryRegistry({ binPath: '/x/bin.js', meshRoot: '/mesh', nodePath: '/usr/bin/node' });
  assert.equal(reg.peers.analyst.env.AGENT_MESH_ENABLED_MODES, 'ask');
  assert.equal(reg.peers.triager.env.AGENT_MESH_ENABLED_MODES, 'ask');
  assert.equal(reg.peers.analyst.root, join('/mesh', 'analyst'));
  assert.deepEqual(reg.peers.analyst.args, ['/x/bin.js', 'serve-a2a', join('/mesh', 'analyst')]);
  assert.throws(() => advisoryRegistry({ meshRoot: '/mesh' }), /binPath/);
  assert.throws(() => advisoryRegistry({ binPath: '/x/bin.js' }), /meshRoot/);
  assert.equal(reg.peers.analyst.command, '/usr/bin/node');
  assert.equal(reg.peers.triager.root, join('/mesh', 'triager'));
});

import { isTerminalState, DONE as DONE_L, REJECTED as REJ_L } from '../src/dev-society/core.js';
test('isTerminalState: true for terminal-labelled open issues, false otherwise', () => {
  for (const l of [DONE_L, REJ_L, 'wontfix', 'duplicate', 'invalid']) {
    assert.equal(isTerminalState(issue(1, [l])), true, l);
  }
  assert.equal(isTerminalState(issue(2, ['bug', 'in-progress'])), false);
  assert.equal(isTerminalState(issue(3, [])), false);
});
