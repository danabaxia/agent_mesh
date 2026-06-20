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
//   DEV_SOCIETY_WORKROOT   where worktrees are created, default <repo>/.dev-society/work
//   DEV_SOCIETY_LEDGER     metrics ledger (jsonl), default <repo>/.dev-society/ledger.jsonl
//   DEV_SOCIETY_BASE       base branch, default main
//   DEV_SOCIETY_TIMEOUT_MS per-A2A-request timeout, default 600000
//   AGENT_MESH_CLAUDE      claude binary (default 'claude')

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, appendFileSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
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
import { runMir } from './mir-run.mjs';
import { runAnalystDailyReview } from './analyst-review-run.mjs';
import { doctor } from '../src/builder/doctor.js';
import { ensureLabels } from '../src/gh-labels.js';
import { acquireBuildLock, releaseBuildLock } from '../src/dev-society/build-lock.js';
import { runSweep as runAutomergeSweep } from '../src/automerge/sweep.js';

const sh = promisify(execFile);
const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BIN = join(repoRoot, 'bin', 'agent-mesh.js');

const cfg = {
  repo: process.env.DEV_SOCIETY_REPO || '',
  workRoot: process.env.DEV_SOCIETY_WORKROOT || join(repoRoot, '.dev-society', 'work'),
  ledger: process.env.DEV_SOCIETY_LEDGER || join(repoRoot, '.dev-society', 'ledger.jsonl'),
  base: process.env.DEV_SOCIETY_BASE || 'main',
  timeoutMs: Number(process.env.DEV_SOCIETY_TIMEOUT_MS || 600000),
};
const once = process.argv.includes('--once');
const selftest = process.argv.includes('--selftest');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const SCHED_MESH_ROOT = process.env.DEV_SOCIETY_MESH_ROOT || join(repoRoot, 'dev-mesh');
const STALE_MS = Number(process.env.DEV_SOCIETY_STALE_MS || 1800000);
const dispatchStatePath = join(repoRoot, '.dev-society', 'dispatch-state.json');
const readDispatchState = () => { try { return JSON.parse(readFileSync(dispatchStatePath, 'utf8')); } catch { return {}; } };
const writeDispatchState = (s) => { mkdirSync(dirname(dispatchStatePath), { recursive: true }); writeFileSync(dispatchStatePath, JSON.stringify(s, null, 2)); };

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
    // Tester-owned: run the suites + emit mir.json/mir.md and sync backlog issues.
    'tester-suite-run': async () => {
      const res = await runMir({
        repoRoot,
        ref: { commit: process.env.GITHUB_SHA || 'local', branch: 'main' },
        dryRun: false,
        runSuites: true,
        gh: async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout,
        now: () => new Date(),
      });
      return res.status === 'ok'
        ? { status: 'ok', output: res.summary }
        : { status: 'fail', error: res.summary };
    },
    // Analyst-owned: agent-driven daily performance review → deduped `idea` issues.
    'analyst-daily-review': async () => {
      const res = await runAnalystDailyReview({
        repoRoot,
        dryRun: false,
        gh: async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout,
        now: () => new Date(),
      });
      return res.status === 'ok'
        ? { status: 'ok', output: res.output }
        : { status: 'fail', error: res.output };
    },
    'label-repair-sweep': () => labelRepairSweep()
      .then((r) => ({ status: 'ok', output: `label-repair-sweep complete (${r.repaired} repaired)` }))
      .catch((e) => { log('label-repair-sweep error:', e.message); return { status: 'fail', error: e.message }; }),
    'issue-sweep': () => sweep()
      .then(() => ({ status: 'ok', output: 'issue-sweep complete' }))
      .catch((e) => { log('issue-sweep error:', e.message); return { status: 'fail', error: e.message }; }),
    // Daemon-driven prompt drain: merge CLEAN+APPROVED PRs on the daemon's reliable ~10min
    // cadence instead of waiting on GitHub Actions' throttled cron (which leaves ready PRs
    // idle ~1-2h). Reuses the gated, tested runSweep (AUTOMERGE_ENABLED + isAutoMergeable);
    // the GitHub-Actions automerge stays as a backstop.
    'automerge-sweep': () => runAutomergeSweep({
      gh: async (a) => (await sh('gh', a, { maxBuffer: 1 << 24 })).stdout,
      repo: cfg.repo,
      enabled: process.env.AUTOMERGE_ENABLED === 'true',
      log: (...a) => log('automerge:', ...a),
    })
      .then((r) => ({ status: 'ok', output: r.disabled ? 'automerge disabled (AUTOMERGE_ENABLED!=true)' : `merged ${r.merged.length}, skipped ${r.skipped}, ineligible ${r.ineligible}` }))
      .catch((e) => { log('automerge-sweep error:', e.message); return { status: 'fail', error: e.message }; }),
  };
  // Materialize managed wiring (registry.json / .mcp.json) before the scheduler
  // can fire any job — the daemon (unlike the dashboard) has no auto-sync, so
  // without this the analyst→tester peer bridge would be missing. registry.json
  // is gitignored generated state; doctor regenerates it in place.
  try {
    await doctor(SCHED_MESH_ROOT, { apply: true, managedOnly: true });
    log('managed wiring synced — meshRoot=' + SCHED_MESH_ROOT);
  } catch (e) {
    log('doctor managed-sync failed (continuing):', e?.message || String(e));
  }
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
    // Self-heal the label first: `gh issue create --label` 422s on an unknown
    // label, and the .catch below would swallow it — heartbeats would silently
    // never file. ensureLabels makes `mesh-heartbeat` exist (the #182 bug class).
    await ensureLabels(gh, ['mesh-heartbeat'], { repo: cfg.repo });
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

const issueClose = (n, body) => gh(['issue', 'close', String(n), '--repo', cfg.repo, '--comment', body]).catch((e) => log('  (close failed)', e.message));
const issueComment = (n, body) => gh(['issue', 'comment', String(n), '--repo', cfg.repo, '--body', body]).catch((e) => log('  (comment failed)', e.message));
const addLabel = (n, l) => gh(['issue', 'edit', String(n), '--repo', cfg.repo, '--add-label', l]).catch(() => {});
const rmLabel = (n, l) => gh(['issue', 'edit', String(n), '--repo', cfg.repo, '--remove-label', l]).catch(() => {});

// All open issues, intentionally UNFILTERED by label — routeFor does all gating/skip logic.
async function listAllOpen() {
  const { stdout } = await gh(['issue', 'list', '--repo', cfg.repo, '--state', 'open',
    '--limit', '100', '--json', 'number,title,body,labels']);
  return JSON.parse(stdout);
}

async function labelRepairSweep() {
  if (!cfg.repo) { log('label-repair-sweep: set DEV_SOCIETY_REPO'); return { repaired: 0 }; }
  const issues = await listAllOpen();
  let repaired = 0;
  for (const issue of issues) {
    const plan = core.planLabelRepair(issue);
    if (!plan) continue;
    for (const label of plan.remove || []) await rmLabel(issue.number, label);
    for (const label of plan.add || []) await addLabel(issue.number, label);
    if (plan.comment) await issueComment(issue.number, plan.comment);
    repaired++;
    rec({
      source: 'daemon',
      type: 'issue.labels.repaired',
      level: 'info',
      summary: `#${issue.number}: ${plan.reason}`,
      ref: `#${issue.number}`,
    });
    log(`label-repair-sweep: #${issue.number} ${plan.reason}`);
  }
  if (!repaired) log('label-repair-sweep: no repairs');
  return { repaired };
}

async function dispatchAdvisory(issue, route) {
  const reg = core.advisoryRegistry({ binPath: BIN, meshRoot: SCHED_MESH_ROOT });
  let client = null;
  try {
    client = await createA2AClient(reg, { requestTimeoutMs: cfg.timeoutMs });
    let prompt;
    if (route.target === 'analyst') {
      prompt = route.reason === 'question' ? core.questionPrompt(issue) : core.analystDraftPrompt(issue);
    } else {
      prompt = core.triagePrompt(issue);
    }
    log(`  → ${route.target} (ask) #${issue.number} [${route.reason}]…`);
    const task = await client.send(route.target, core.a2aMessage('ask', prompt));
    const text = core.taskText(task) || '(no output)';
    await issueComment(issue.number, `🤖 **${route.target}** (A2A \`ask\`):\n\n${text.slice(0, 60000)}`);
    if (route.advance) await addLabel(issue.number, route.advance);
  } finally {
    await client?.close().catch(() => {});
  }
}

async function runSpecTask(issue) {
  const branch = `dev-society/spec-${issue.number}`;
  const wt = join(cfg.workRoot, `spec-${issue.number}`);
  log(`▶ spec #${issue.number} "${issue.title}" → ${branch}`);
  let client = null;
  try {
    rmSync(wt, { recursive: true, force: true });
    await git(['worktree', 'prune'], repoRoot);
    await git(['fetch', 'origin', cfg.base, '-q'], repoRoot);
    await git(['worktree', 'add', '-f', '-B', branch, wt, `origin/${cfg.base}`], repoRoot);
    client = await createA2AClient(core.advisoryRegistry({ binPath: BIN, meshRoot: SCHED_MESH_ROOT }), { requestTimeoutMs: cfg.timeoutMs });
    const task = await client.send('analyst', core.a2aMessage('ask', core.analystSpecPrompt(issue)));
    const spec = core.taskText(task);
    if (!spec || spec.length < 200) {
      await issueComment(issue.number, '🤖 A2A society Analyst did not produce a usable spec — needs a human.');
      return;
    }
    const slug = String(issue.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || `issue-${issue.number}`;
    const date = new Date().toISOString().slice(0, 10);
    const rel = `docs/superpowers/specs/${date}-${slug}-design.md`;
    mkdirSync(join(wt, dirname(rel)), { recursive: true });
    writeFileSync(join(wt, rel), spec.endsWith('\n') ? spec : spec + '\n');
    await git(['add', rel], wt);
    await git(['-c', 'commit.gpgsign=false', 'commit', '-qm',
      `spec: ${issue.title}\n\nDrafted by the A2A dev-society (Analyst over A2A ask) for #${issue.number}.`], wt);
    await git(['push', '-u', 'origin', branch, '--force-with-lease'], wt);
    const { stdout } = await gh(['pr', 'create', '--repo', cfg.repo, '--base', cfg.base, '--head', branch,
      '--title', `spec: ${issue.title} (#${issue.number})`,
      '--body', `Draft spec for #${issue.number}, authored by the **A2A dev-society** Analyst (A2A \`ask\`). Human review required before \`approved\`.`]);
    await rmLabel(issue.number, core.SPEC_DRAFT);
    await addLabel(issue.number, core.SPEC_IN_REVIEW);
    await issueComment(issue.number, `🤖 Spec PR opened: ${stdout.trim()}`);
    log(`  ✓ spec PR: ${stdout.trim()}`);
  } finally {
    await client?.close().catch(() => {});
    rmSync(wt, { recursive: true, force: true });
    await git(['worktree', 'prune'], repoRoot).catch(() => {});
  }
}

// registryFor moved to src/dev-society/core.js (pure + hermetically tested) — the daemon
// calls core.registryFor(wt, { binPath: BIN }). Reviewer stays ask-only there (S1).
async function runOneTask(issue) {
  const branch = core.branchName(issue.number);
  const wt = join(cfg.workRoot, `issue-${issue.number}`);
  log(`▶ claim #${issue.number} "${issue.title}" → ${branch}`);
  rec({ source: 'daemon', type: 'issue.picked', summary: `picked #${issue.number}: ${String(issue.title || '').slice(0, 80)}`, ref: `#${issue.number}` });
  await addLabel(issue.number, core.IN_PROGRESS);
  // Hold the build-lock for the whole build so deploy-sync defers the daemon
  // restart until we finish — a restart mid-build orphans this issue (in-progress,
  // no PR). Released in the finally below; goes stale on a hung build (safety valve).
  acquireBuildLock(repoRoot, { issue: issue.number });

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
    const errMsg = String(taskErr && taskErr.message || taskErr);
    rec({ source: 'daemon', type: 'task.error', level: 'error', summary: `#${issue.number} failed: ${errMsg.slice(0, 120)}`, ref: `#${issue.number}` });
    // Prevent re-claim loop: when the coder/wire fails (timeout, spawn ENOENT,
    // A2A error) the eligibility check (core.eligibleForCoder) is supposed to
    // exclude the issue via the IN_PROGRESS label set at the top of this fn —
    // but that addLabel call swallows its own errors (line 184 `.catch(() => {})`),
    // so a silent label-write failure (or another agent stripping IN_PROGRESS)
    // leaves the issue approved + route:a2a and the next sweep burns another
    // cfg.timeoutMs cycle on the same impossible task. Empirically #98 above
    // re-claimed 4× in 24h before we caught it. Belt-and-suspenders fix:
    // explicitly remove `approved` and add `blocked` so the issue drops out
    // of every "eligible" filter the mesh has, then surface the error on the
    // issue thread for a human (who decides whether to decompose & re-approve).
    // Mirrors the existing tests-red branch above (line 313-314).
    await rmLabel(issue.number, core.APPROVED).catch(() => {});
    await rmLabel(issue.number, core.IN_PROGRESS).catch(() => {});
    await addLabel(issue.number, core.BLOCKED).catch(() => {});
    await issueComment(
      issue.number,
      `🤖 A2A society Coder failed: \`${errMsg.slice(0, 400)}\`\n\n` +
      `Removed \`approved\` and added \`blocked\` to prevent the daemon from re-claiming this issue on every sweep ` +
      `(see https://github.com/danabaxia/agent_mesh/issues/98 for the bug this fixes). ` +
      `Diagnose the failure, then either re-approve (if it was transient) or decompose the task into smaller issues.`
    ).catch(() => {});
    throw taskErr;  // re-throw so tick()'s catch can log it
  } finally {
    await client.close().catch(() => {});
    // record metrics for the eval/perf ledger (real-task scorecard input)
    mkdirSync(dirname(cfg.ledger), { recursive: true });
    appendFileSync(cfg.ledger, JSON.stringify(core.ledgerRecord({ issue, coderTask, reviewerTask, tests, prNumber })) + '\n');
    rmSync(wt, { recursive: true, force: true });
    await git(['worktree', 'prune'], repoRoot).catch(() => {});
    releaseBuildLock(repoRoot);   // build done → deploy-sync may restart on the next tick
  }
}

async function sweep() {
  if (!cfg.repo) { log('sweep: set DEV_SOCIETY_REPO'); return; }
  const issues = await listAllOpen();
  // Self-heal: an open issue carrying a terminal label (done/rejected/wontfix/duplicate/
  // invalid) never gets closed by anything else — close it so it stops hanging open.
  for (const i of issues.filter((x) => core.isTerminalState(x))) {
    log(`  ✓ closing terminal issue #${i.number} (${core.labelNames(i).join(',')})`);
    await issueClose(i.number, '🤖 dev-mesh: closing — issue is in a terminal state (done/rejected/wontfix/duplicate/invalid).');
  }
  const state = readDispatchState();
  const now = Date.now();
  // liveBuilds stays empty by design: the scheduler runs one issue-sweep at a time
  // per agent (in-memory lock) and runOneTask is awaited within the tick, so no build
  // is ever concurrent. Stale-reclaim therefore relies on STALE_MS, which MUST exceed
  // the A2A build timeout (cfg.timeoutMs) so a still-running build is never re-claimed.
  const liveBuilds = new Set();
  const staleClaims = new Set(
    issues
      .filter((i) => core.labelNames(i).includes(core.IN_PROGRESS))
      .filter((i) => { const p = state[i.number]; return !p || (now - (p.dispatchedAt || 0)) > STALE_MS; })
      .map((i) => i.number),
  );
  const routed = issues
    .map((i) => ({ issue: i, route: core.routeFor(i, { liveBuilds, staleClaims }) }))
    .filter((x) => x.route.target);

  // Advisory routes (analyst/triager): cheap A2A asks → comments. Dispatch all pending.
  for (const { issue, route } of routed.filter((r) => r.route.mode === 'ask')) {
    if (!core.shouldDispatch(issue, route, state)) continue;
    try {
      if (route.spec) await runSpecTask(issue);
      else await dispatchAdvisory(issue, route);
      core.recordDispatch(state, issue, route, now);
    } catch (e) { log(`  advisory #${issue.number} (${route.target}) failed:`, e.message); }
  }
  writeDispatchState(state);

  // Code routes (coder do): heavy + serialize on the worktree → one build per tick (FIFO).
  const coderQ = routed.filter((r) => r.route.mode === 'do').map((r) => r.issue);
  const pick = core.selectCoderTask(coderQ);
  if (!pick) { log('sweep: no coder task this tick'); return; }
  core.recordDispatch(state, pick, { target: 'coder' }, now);
  writeDispatchState(state);
  try { await runOneTask(pick); } catch (e) { log(`  coder #${pick.number} failed:`, e.message); }
}

async function main() {
  if (selftest) {
    const sample = [
      { number: 10, title: 'idea: new thing', labels: ['idea'] },
      { number: 11, title: 'idea: approved thing', labels: ['idea', 'approved'] },
      { number: 12, title: 'fix the bug', labels: ['bug'] },
      { number: 13, title: 'infra_auth: nightly broke', labels: [] },
      { number: 14, title: 'how do I X?', labels: ['question'] },
      { number: 15, title: 'shipped', labels: ['done'] },
      { number: 16, title: 'finalize spec', labels: ['spec:draft'] },
    ];
    const got = Object.fromEntries(sample.map((i) => [i.number, core.routeFor(i).target]));
    log('selftest routing:', JSON.stringify(got));
    const want = { 10: null, 11: 'analyst', 12: 'coder', 13: 'triager', 14: 'analyst', 15: null, 16: 'analyst' };
    for (const [n, t] of Object.entries(want)) {
      if (got[n] !== t) { console.error(`selftest FAILED: #${n} expected ${t}, got ${got[n]}`); process.exit(1); }
    }
    log('selftest OK');
    return;
  }
  if (!cfg.repo) { console.error('Set DEV_SOCIETY_REPO=owner/repo'); process.exit(1); }
  mkdirSync(cfg.workRoot, { recursive: true });
  if (once) { await labelRepairSweep(); await sweep(); return; }
  log(`dev-society daemon up — repo=${cfg.repo} base=${cfg.base}; issue-sweep runs via the scheduler every 10m`);
  // Always-on: the scheduler started at module load drives issue-sweep; it keeps the process alive.
}

main().catch((e) => { console.error(e); process.exit(1); });
