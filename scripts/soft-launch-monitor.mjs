#!/usr/bin/env node
// scripts/soft-launch-monitor.mjs — impure shell: 24h clean-clock watchdog for ③a research-escalation.
// Reads daemon logs, schedule state, and GH issues; advances the clean-clock; persists state.
// Always exits 0 — failure is data, not an exception.
import { execFile } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  DEFAULT_WINDOW_MS,
  scanDaemonLog,
  scanErrLog,
  scanScheduleState,
  findStrandedEscalations,
  checkDraftInvariant,
  advanceClock,
  summarize,
} from '../src/soft-launch-monitor/core.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const deployRoot = process.env.DEV_SOCIETY_DEPLOY_ROOT || join(homedir(), '.agent-mesh', 'deploy');
const statePath = process.env.SOFT_LAUNCH_MONITOR_STATE || join(homedir(), '.agent-mesh', 'soft-launch-monitor-state.json');
let repo = process.env.DEV_SOCIETY_REPO || '';

// The 24/7 daemon writes its logs under <deployRoot>/.dev-society/ and each agent's
// scheduler state under <deployRoot>/dev-mesh/<agent>/.agent-mesh/. (Earlier these paths
// were wrong — deployRoot/daemon.out.log etc. don't exist — so the scans silently read
// empty files and never fired. Fixed here.)
const daemonOutLog = join(deployRoot, '.dev-society', 'daemon.out.log');
const daemonErrLog = join(deployRoot, '.dev-society', 'daemon.err.log');
const analystScheduleStatePath = join(deployRoot, 'dev-mesh', 'analyst', '.agent-mesh', 'schedule-state.json');
const coderScheduleStatePath = join(deployRoot, 'dev-mesh', 'coder', '.agent-mesh', 'schedule-state.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function fileBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function atomicWriteJson(path, obj) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    console.error(`[soft-launch-monitor] warn: could not write ${path}: ${e.message}`);
  }
}

async function gh(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 1 << 24 });
    return stdout;
  } catch {
    return '';
  }
}

async function resolveRepo() {
  if (repo) return repo;
  const out = await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return out.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const nowIso = new Date().toISOString();

  // Resolve repo (best-effort — some checks below need it)
  repo = await resolveRepo();

  // Read previous state
  const prevState = readJson(statePath);

  // sinceIso: on first run use nowIso so we don't attribute pre-existing log lines
  const sinceIso = prevState?.liveSince || nowIso;

  // Previous err-log byte baseline
  const prevErrBytes = prevState?.errLogBytes ?? null;

  // -------------------------------------------------------------------------
  // Collect signals
  // -------------------------------------------------------------------------

  // 1. Daemon stdout log — both ③a (research-escalation) and ③b (research-fix) error lines
  //    + advisory-route failures (the advisoryRegistry-env/routeFor blast radius).
  const daemonLogText = readText(daemonOutLog);
  const daemonLogIssues = scanDaemonLog(daemonLogText, { sinceIso, features: ['research-escalation', 'research-fix'] });

  // 2. Daemon stderr log growth
  const currErrBytes = fileBytes(daemonErrLog);
  // On first run: baseline to current size — no false positive for pre-existing stderr
  const effectivePrevErrBytes = prevErrBytes !== null ? prevErrBytes : currErrBytes;
  const errLogIssues = scanErrLog(effectivePrevErrBytes, currErrBytes);

  // 3. Schedule state — ③a's research-escalation (analyst) + ③b's research-fix (coder)
  const analystState = readJson(analystScheduleStatePath) || {};
  const coderState = readJson(coderScheduleStatePath) || {};
  const scheduleIssues = [
    ...scanScheduleState(analystState, 'research-escalation'),
    ...scanScheduleState(coderState, 'research-fix'),
  ];

  // 4. Stranded escalations via GitHub
  const strandedIssues = await collectStrandedEscalations(repo, nowIso);

  // 5. ③b never-auto-merged invariant: every open research-fix draft PR must be a draft + do-not-merge
  const draftInvariantIssues = await collectDraftInvariant(repo);

  // -------------------------------------------------------------------------
  // Advance clock
  // -------------------------------------------------------------------------
  const foundIssues = [...daemonLogIssues, ...errLogIssues, ...scheduleIssues, ...strandedIssues, ...draftInvariantIssues];
  const nextState = advanceClock(prevState, foundIssues, nowIso, DEFAULT_WINDOW_MS);

  // Persist errLogBytes alongside state
  const stateToWrite = { ...nextState, errLogBytes: currErrBytes };
  atomicWriteJson(statePath, stateToWrite);

  // Sibling report
  const reportPath = statePath.replace(/\.json$/, '-report.json');
  atomicWriteJson(reportPath, { ...nextState, foundIssues });

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------
  const summary = summarize(nextState);
  console.log(summary);
  for (const iss of foundIssues) {
    const detail = iss.detail || iss.line || '';
    console.log(`  [${iss.severity}] ${iss.signal}${detail ? ': ' + detail : ''}`);
  }
  // Machine-readable line (always last)
  console.log(`STATUS: ${nextState.status}`);
}

async function collectStrandedEscalations(repo, nowIso) {
  if (!repo) return [];
  const nowMs = Date.parse(nowIso);
  try {
    const listOut = await gh([
      'issue', 'list',
      '--repo', repo,
      '--label', 'needs-human',
      '--state', 'open',
      '--json', 'number,createdAt',
      '--limit', '100',
    ]);
    if (!listOut.trim()) return [];
    let ghIssues;
    try { ghIssues = JSON.parse(listOut); } catch { return []; }

    // Cap at 20 diagnosis checks
    const toCheck = ghIssues.slice(0, 20);
    const enriched = await Promise.all(toCheck.map(async (iss) => {
      const createdAtMs = Date.parse(iss.createdAt);
      const hasDiagnosis = await checkDiagnosis(repo, iss.number);
      return { number: iss.number, createdAtMs, hasDiagnosis };
    }));

    return findStrandedEscalations(enriched, nowMs);
  } catch {
    return [];
  }
}

// ③b never-auto-merged invariant: list open PRs and flag any research-fix branch PR that
// is not a draft or lacks the do-not-merge hold label (a breach = a ③b fix PR could merge).
async function collectDraftInvariant(repo) {
  if (!repo) return [];
  try {
    const out = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,isDraft,headRefName,labels', '--limit', '100']);
    if (!out.trim()) return [];
    let prs;
    try { prs = JSON.parse(out); } catch { return []; }
    return checkDraftInvariant(prs);
  } catch {
    return [];
  }
}

async function checkDiagnosis(repo, number) {
  const out = await gh(['issue', 'view', String(number), '--repo', repo, '--json', 'comments']);
  if (!out.trim()) return false;
  try {
    const { comments = [] } = JSON.parse(out);
    return comments.some((c) => String(c.body || '').includes('<!-- research-escalation -->'));
  } catch {
    return false;
  }
}

main().catch((e) => {
  // Never throw to the top level — failure is data
  console.error(`[soft-launch-monitor] unexpected error: ${e.message}`);
  console.log('STATUS: error');
  process.exit(0);
});
