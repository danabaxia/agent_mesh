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
import { mkdirSync, appendFileSync, rmSync, existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createA2AClient } from '../src/a2a/stdio-client.js';
import * as core from '../src/dev-society/core.js';
import { createScheduler } from '../src/schedule/scheduler.js';
import { pollGhActivity } from '../src/dev-society/gh-activity.js';
import { runHeartbeat } from '../src/mesh-health/heartbeat-runner.js';
import { listAllSchedules } from '../src/schedule/list-all.js';
import { computeNextRun } from '../src/schedule/schedule-cadence.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_FAIL_THRESHOLD, DEFAULT_HEARTBEAT_OVERDUE_GRACE_MS, DEFAULT_HEARTBEAT_STALE_MS, DEFAULT_HEARTBEAT_ESCALATE_AFTER, DEFAULT_ACTIVITY_KEEP_DAYS } from '../src/config.js';
import { recordActivity, pruneActivity } from '../src/activity-log/log.js';

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
const SCHED_MESH_ROOT = process.env.DEV_SOCIETY_MESH_ROOT || join(repoRoot, 'dev-mesh');

// Always-on standard scheduler: runs agents' .agent/schedule.json jobs 24/7.
// Skipped in --once/--selftest (those paths exit early; scheduler must not start).
let sched = null;
let heartbeatTimer = null;
// Activity-log emit shorthand — module-level so runOneTask (top-level fn) can reach it.
// rec is a no-op stub until the live block below assigns the real implementation;
// selftest/once never enter that block, so no files are written under those modes.
let rec = () => {};
const seenRuns = new Set();  // gh-activity dedup (module-level; populated only when live block runs)
if (!once && !selftest) {
  const activityDir = process.env.AGENT_MESH_ACTIVITY_DIR || join(repoRoot, '.dev-society');
  const activityKeepDays = Number(process.env.AGENT_MESH_ACTIVITY_KEEP_DAYS) || DEFAULT_ACTIVITY_KEEP_DAYS;
  rec = (ev) => recordActivity(ev, { dir: activityDir });            // fail-safe shorthand
  pruneActivity({ dir: activityDir, keepDays: activityKeepDays });   // prune on startup

  const ghActivityPath = process.env.AGENT_MESH_GH_ACTIVITY || join(repoRoot, '.dev-society', 'gh-activity.json');
  const builtins = {
    'gh-activity-poll': () => pollGhActivity({
      gh: async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout,
      repo: cfg.repo,
      writeCache: (records) => {
        mkdirSync(dirname(ghActivityPath), { recursive: true });
        writeFileSync(ghActivityPath, JSON.stringify(records));
        for (const r of records) {
          if (typeof r.id !== 'string' || r.id.endsWith(':e')) continue;   // node records only (skip a2a edges)
          if (seenRuns.has(r.id)) continue;
          seenRuns.add(r.id);
          rec({ source: 'gh-activity', agent: r.agent, type: 'ci.run', summary: `${r.route || 'ci'}${r.finished_at ? ' (done)' : ' (running)'}`, ref: r.id });
        }
      },
    }),
    // Refresh the Daily Mesh Report cache the dashboard's /api/daily reads (incl.
    // issues.openNow). Runs the existing script, which writeCache()s unconditionally
    // (no --post, so no rolling-issue write). Keeps the dashboard from going stale.
    'daily-report-refresh': async () => {
      try {
        await sh('node', [join(repoRoot, 'scripts', 'daily-report.mjs')], {
          env: { ...process.env, DEV_SOCIETY_REPO: cfg.repo },
          maxBuffer: 1 << 24,
        });
        return { status: 'ok', output: 'daily report cache refreshed' };
      } catch (e) {
        return { status: 'fail', error: e?.message || String(e) };
      }
    },
  };
  sched = createScheduler({
    meshRoot: SCHED_MESH_ROOT, builtins,
    onJobResult: ({ agentName, jobId, status, summary }) =>
      rec({ source: 'scheduler', agent: agentName, type: 'job.run', level: status === 'ok' ? 'info' : 'warn', summary: `${jobId}: ${status}${summary ? ' — ' + summary : ''}`, ref: jobId }),
  });
  sched.start();
  log('scheduler started — meshRoot=' + SCHED_MESH_ROOT);

  // Mesh-level heartbeat: assess schedule health, auto-heal, and escalate via GH issues.
  const heartbeatFile = process.env.AGENT_MESH_HEARTBEAT_FILE || join(repoRoot, '.dev-society', 'heartbeat.json');
  const _hbRaw = process.env.AGENT_MESH_HEARTBEAT_INTERVAL_MS;
  const HB_INTERVAL = (_hbRaw === undefined || _hbRaw === '') ? DEFAULT_HEARTBEAT_INTERVAL_MS : Number(_hbRaw);
  const hbThresholds = {
    failThreshold: Number(process.env.AGENT_MESH_HEARTBEAT_FAIL_THRESHOLD) || DEFAULT_HEARTBEAT_FAIL_THRESHOLD,
    overdueGraceMs: Number(process.env.AGENT_MESH_HEARTBEAT_OVERDUE_GRACE_MS) || DEFAULT_HEARTBEAT_OVERDUE_GRACE_MS,
    staleMs: Number(process.env.AGENT_MESH_HEARTBEAT_STALE_MS) || DEFAULT_HEARTBEAT_STALE_MS,
    escalateAfter: Number(process.env.AGENT_MESH_HEARTBEAT_ESCALATE_AFTER) || DEFAULT_HEARTBEAT_ESCALATE_AFTER,
  };

  const applyHeal = async ({ agent, jobId, action, cadence, now }) => {
    const statePath = join(SCHED_MESH_ROOT, agent, '.agent-mesh', 'schedule-state.json');
    let state = {};
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return; }
    const entry = state[jobId]; if (!entry) return;
    if (action === 'clear_stale') entry.running = false;
    if (action === 'rearm' && cadence) { entry.nextRunAt = computeNextRun(cadence, now).toISOString(); entry.running = false; }
    state[jobId] = entry;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  };

  const openIssue = async ({ key, action, title, body }) => {
    const found = await gh(['issue', 'list', '--repo', cfg.repo, '--state', 'open', '--search', `${key} in:body`, '--json', 'number', '--jq', '.[0].number'])
      .then((r) => r.stdout.trim()).catch(() => '');
    if (action === 'close') {
      if (found) await gh(['issue', 'close', found, '--repo', cfg.repo, '--comment', body]).catch((e) => log('  (hb close failed)', e.message));
      return;
    }
    if (found) { await gh(['issue', 'comment', found, '--repo', cfg.repo, '--body', body]).catch((e) => log('  (hb comment failed)', e.message)); return; }
    await gh(['issue', 'create', '--repo', cfg.repo, '--title', title, '--body', body, '--label', 'mesh-heartbeat']).catch((e) => log('  (hb create failed)', e.message));
  };

  const heartbeatTick = async () => {
    const r = await runHeartbeat({
      meshRoot: SCHED_MESH_ROOT, now: new Date(), thresholds: hbThresholds,
      listSchedules: (mr) => listAllSchedules({ meshRoot: mr }).then((x) => x.jobs),
      readSnapshot: async () => { try { return JSON.parse(readFileSync(heartbeatFile, 'utf8')); } catch { return null; } },
      writeSnapshot: async (snap) => { mkdirSync(dirname(heartbeatFile), { recursive: true }); writeFileSync(heartbeatFile, JSON.stringify(snap, null, 2)); },
      applyHeal, openIssue,
    });
    if (r.status === 'fail') log('heartbeat failed:', r.error);
    else if (r.summary && (r.summary.failing || r.summary.overdue || r.summary.stuck)) log('heartbeat:', JSON.stringify(r.summary));
    if (r && r.summary && (r.summary.failing || r.summary.overdue || r.summary.stuck || r.summary.escalated)) {
      rec({ source: 'heartbeat', type: 'heartbeat.summary', level: r.summary.escalated ? 'error' : 'warn', summary: `health: ${JSON.stringify(r.summary)}` });
    }
  };

  if (HB_INTERVAL > 0) {
    heartbeatTimer = setInterval(heartbeatTick, HB_INTERVAL);
    log('heartbeat started — interval=' + HB_INTERVAL + 'ms');
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { sched?.stop(); } catch {} try { clearInterval(heartbeatTimer); } catch {} process.exit(0); });

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

// registryFor moved to src/dev-society/core.js (pure + hermetically tested) — the daemon
// calls core.registryFor(wt, { binPath: BIN }). Reviewer stays ask-only there (S1).
async function runOneTask(issue) {
  const branch = core.branchName(issue.number);
  const wt = join(cfg.workRoot, `issue-${issue.number}`);
  log(`▶ claim #${issue.number} "${issue.title}" → ${branch}`);
  rec({ source: 'daemon', type: 'issue.picked', summary: `picked #${issue.number}: ${String(issue.title || '').slice(0, 80)}`, ref: `#${issue.number}` });
  await addLabel(issue.number, core.IN_PROGRESS);

  // fresh worktree off the base branch
  rmSync(wt, { recursive: true, force: true });
  await git(['worktree', 'prune'], repoRoot);
  await git(['fetch', 'origin', cfg.base, '-q'], repoRoot);
  await git(['worktree', 'add', '-f', '-B', branch, wt, `origin/${cfg.base}`], repoRoot);

  const client = await createA2AClient(core.registryFor(wt, { binPath: BIN }), { requestTimeoutMs: cfg.timeoutMs });
  let coderTask, reviewerTask = null, tests = null, prNumber = null;
  try {
    // 1) Coder (top-level do) authors the change in the worktree (path-guard confined).
    log('  → coder (do)…');
    coderTask = await client.send('coder', core.a2aMessage('do', core.coderPrompt(issue)));
    const oc = core.taskOutcome(coderTask);
    log(`  ← coder status=${oc.status} files=${JSON.stringify(oc.filesChanged)}`);
    rec({ source: 'daemon', agent: 'coder', type: 'delegate.done', level: oc.status === 'done' ? 'info' : 'warn', summary: `coder #${issue.number} → ${oc.status}`, ref: `#${issue.number}` });

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
        if (prNumber) rec({ source: 'daemon', type: 'pr.opened', summary: `opened PR #${prNumber} for #${issue.number}`, ref: `pr#${prNumber}` });
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
  } catch (taskErr) {
    rec({ source: 'daemon', type: 'task.error', level: 'error', summary: `#${issue.number} failed: ${String(taskErr && taskErr.message || taskErr).slice(0, 120)}`, ref: `#${issue.number}` });
    throw taskErr;  // re-throw so tick()'s catch can log it
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
