#!/usr/bin/env node
// scripts/dev-society-daemon.mjs — P1: the persistent A2A Dev-Society daemon (the impure
// "outer shell"). It watches GitHub for approved + route:a2a issues, drives the REAL A2A mesh
// to author the change (Coder = top-level `do`; Reviewer = `ask`), runs the suite, and opens a
// PR. The GitHub-Actions Dev-mesh (review/CI/merge/curate) takes over from the PR — this
// AUGMENTS it, it does not replace it.
//
// Design + the P0 findings this encodes:
//   docs/superpowers/specs/2026-06-16-a2a-dev-society-design.md
//   - onward delegation is ask-only → the driver issues the `do` to the Coder directly.
//   - memory/ + trusted config are path-guard-protected; git/gh/test execution has no `Bash`
//     in `do`. So ALL trusted writes/IO live HERE, in the daemon, never in an A2A worker.
//
// RUN (on your machine / a small VPS — NOT GitHub Actions; that's ephemeral):
//   export DEV_SOCIETY_REPO=danabaxia/agent_mesh        # owner/repo
//   gh auth login                                       # gh CLI authenticated
//   claude --version                                    # claude CLI authenticated
//   node scripts/dev-society-daemon.mjs                 # poll forever
//   node scripts/dev-society-daemon.mjs --once          # process at most one task, then exit (cron-friendly)
//   node scripts/dev-society-daemon.mjs --selftest      # no GitHub/claude — just prove wiring
//
// Env (all optional except DEV_SOCIETY_REPO for live mode):
//   DEV_SOCIETY_REPO       owner/repo (required live)
//   DEV_SOCIETY_POLL_MS    poll interval, default 60000
//   DEV_SOCIETY_WORKROOT   where worktrees are created, default <repo>/.dev-society/work
//   DEV_SOCIETY_LEDGER     metrics ledger (jsonl), default <repo>/.dev-society/ledger.jsonl
//   DEV_SOCIETY_BASE       base branch, default main
//   DEV_SOCIETY_TIMEOUT_MS per-A2A-request timeout, default 600000
//   AGENT_MESH_CLAUDE      claude binary (default 'claude')

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, appendFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createA2AClient } from '../src/a2a/stdio-client.js';
import * as core from '../src/dev-society/core.js';

const sh = promisify(execFile);
const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BIN = join(repoRoot, 'bin', 'agent-mesh.js');

const cfg = {
  repo: process.env.DEV_SOCIETY_REPO || '',
  pollMs: Number(process.env.DEV_SOCIETY_POLL_MS || 60000),
  workRoot: process.env.DEV_SOCIETY_WORKROOT || join(repoRoot, '.dev-society', 'work'),
  ledger: process.env.DEV_SOCIETY_LEDGER || join(repoRoot, '.dev-society', 'ledger.jsonl'),
  base: process.env.DEV_SOCIETY_BASE || 'main',
  timeoutMs: Number(process.env.DEV_SOCIETY_TIMEOUT_MS || 600000),
};
const once = process.argv.includes('--once');
const selftest = process.argv.includes('--selftest');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── GitHub shell (impure; uses the `gh` CLI the user authenticates) ─────────────
const gh = (args, opts = {}) => sh('gh', args, { maxBuffer: 1 << 24, ...opts });
const git = (args, cwd) => sh('git', args, { cwd, maxBuffer: 1 << 24 });

async function listEligible() {
  const { stdout } = await gh(['issue', 'list', '--repo', cfg.repo, '--state', 'open',
    '--label', core.APPROVED, '--label', core.ROUTE_LABEL, '--limit', '50',
    '--json', 'number,title,body,labels']);
  return JSON.parse(stdout);
}
const issueComment = (n, body) => gh(['issue', 'comment', String(n), '--repo', cfg.repo, '--body', body]).catch((e) => log('  (comment failed)', e.message));
const addLabel = (n, l) => gh(['issue', 'edit', String(n), '--repo', cfg.repo, '--add-label', l]).catch(() => {});
const rmLabel = (n, l) => gh(['issue', 'edit', String(n), '--repo', cfg.repo, '--remove-label', l]).catch(() => {});

// ── A2A: drive the real mesh on a worktree (Coder do, Reviewer ask) ─────────────
function registryFor(worktree) {
  const mkPeer = (env) => ({ root: worktree, command: 'node', args: [BIN, 'serve-a2a', worktree], cwd: worktree, env });
  return {
    peers: {
      coder: mkPeer({ AGENT_MESH_ENABLED_MODES: 'ask,do' }),
      reviewer: mkPeer({ AGENT_MESH_ENABLED_MODES: 'ask' }),
    },
  };
}

async function runOneTask(issue) {
  const branch = core.branchName(issue.number);
  const wt = join(cfg.workRoot, `issue-${issue.number}`);
  log(`▶ claim #${issue.number} "${issue.title}" → ${branch}`);
  await addLabel(issue.number, core.IN_PROGRESS);

  // fresh worktree off the base branch
  rmSync(wt, { recursive: true, force: true });
  await git(['worktree', 'prune'], repoRoot);
  await git(['fetch', 'origin', cfg.base, '-q'], repoRoot);
  await git(['worktree', 'add', '-f', '-B', branch, wt, `origin/${cfg.base}`], repoRoot);

  const client = await createA2AClient(registryFor(wt), { requestTimeoutMs: cfg.timeoutMs });
  let coderTask, reviewerTask = null, tests = null, prNumber = null;
  try {
    // 1) Coder (top-level do) authors the change in the worktree (path-guard confined).
    log('  → coder (do)…');
    coderTask = await client.send('coder', core.a2aMessage('do', core.coderPrompt(issue)));
    const oc = core.taskOutcome(coderTask);
    log(`  ← coder status=${oc.status} files=${JSON.stringify(oc.filesChanged)}`);

    if (core.taskSucceeded(coderTask) && Array.isArray(oc.filesChanged) && oc.filesChanged.length) {
      // 2) Tester = shell step (workers can't run the suite — no Bash in do).
      try {
        await sh(process.execPath, ['run-all-tests.mjs'], { cwd: wt, maxBuffer: 1 << 26 });
        tests = { passed: true, summary: 'suite green' };
      } catch (e) {
        tests = { passed: false, summary: (e.stdout || e.message || '').toString().split('\n').slice(-6).join('\n') };
      }
      log(`  ← tests passed=${tests.passed}`);

      // 3) Reviewer (ask) reviews the diff as data.
      const { stdout: diff } = await git(['--no-pager', 'diff', `origin/${cfg.base}`], wt);
      log('  → reviewer (ask)…');
      reviewerTask = await client.send('reviewer', core.a2aMessage('ask', core.reviewerPrompt(issue, diff)));
      const review = core.taskText(reviewerTask);

      // 4) Driver does the trusted writes: commit → push → PR (only if green).
      if (core.shouldOpenPR({ coderTask, tests })) {
        await git(['add', '-A'], wt);
        await git(['-c', 'commit.gpgsign=false', 'commit', '-qm',
          `${issue.title}\n\nCloses #${issue.number}\n\nAuthored by the A2A dev-society (Coder over A2A do).`], wt);
        await git(['push', '-u', 'origin', branch, '--force-with-lease'], wt);
        const body = `Closes #${issue.number}\n\nAuthored by the **A2A dev-society** — Coder agent over the A2A \`do\` wire, then suite-checked by the daemon.\n\n### Reviewer (A2A \`ask\`)\n${review.slice(0, 4000)}`;
        const { stdout } = await gh(['pr', 'create', '--repo', cfg.repo, '--base', cfg.base, '--head', branch,
          '--title', `${issue.title} (#${issue.number})`, '--body', body]);
        prNumber = (stdout.match(/\/pull\/(\d+)/) || [])[1] || null;
        log(`  ✓ PR opened: ${stdout.trim()}`);
        await rmLabel(issue.number, core.IN_PROGRESS);
        await addLabel(issue.number, core.PR_IN_REVIEW);
      } else {
        log('  ✗ tests red — not opening a PR; flagging for a human');
        await issueComment(issue.number, `🤖 A2A society built this but the suite is red — needs a human.\n\n${tests.summary}`);
        await rmLabel(issue.number, core.IN_PROGRESS);
        await addLabel(issue.number, core.BLOCKED);
      }
    } else {
      const oc2 = core.taskOutcome(coderTask);
      log('  ✗ coder produced no usable change');
      await issueComment(issue.number, `🤖 A2A society Coder did not produce a usable change (status ${oc2.status}${oc2.errorCode ? ', ' + oc2.errorCode : ''}) — needs a human.`);
      await rmLabel(issue.number, core.IN_PROGRESS);
      await addLabel(issue.number, core.BLOCKED);
    }
  } finally {
    await client.close().catch(() => {});
    // record metrics for the eval/perf ledger (real-task scorecard input)
    mkdirSync(dirname(cfg.ledger), { recursive: true });
    appendFileSync(cfg.ledger, JSON.stringify(core.ledgerRecord({ issue, coderTask, reviewerTask, tests, prNumber })) + '\n');
    rmSync(wt, { recursive: true, force: true });
    await git(['worktree', 'prune'], repoRoot).catch(() => {});
  }
}

async function tick() {
  const issues = await listEligible();
  const task = core.selectTask(issues);
  if (!task) { log('no eligible (approved + route:a2a) tasks'); return false; }
  await runOneTask(task);
  return true;
}

async function main() {
  if (selftest) {
    // No GitHub/claude — prove selection + wiring with a sample.
    const sample = [
      { number: 7, title: 'routed', labels: [core.APPROVED, core.ROUTE_LABEL] },
      { number: 3, title: 'not routed', labels: [core.APPROVED] },
    ];
    const picked = core.selectTask(sample);
    log('selftest: BIN exists =', existsSync(BIN), '| picked =', picked && picked.number, '| branch =', picked && core.branchName(picked.number));
    log('selftest: config =', JSON.stringify(cfg));
    if (!picked || picked.number !== 7) { console.error('selftest FAILED'); process.exit(1); }
    log('selftest OK'); return;
  }
  if (!cfg.repo) { console.error('Set DEV_SOCIETY_REPO=owner/repo'); process.exit(1); }
  mkdirSync(cfg.workRoot, { recursive: true });
  log(`dev-society daemon up — repo=${cfg.repo} base=${cfg.base} poll=${cfg.pollMs}ms once=${once}`);
  do {
    try { await tick(); } catch (e) { log('tick error:', e.message); }
    if (!once) await new Promise((r) => setTimeout(r, cfg.pollMs));
  } while (!once);
}

main().catch((e) => { console.error(e); process.exit(1); });
