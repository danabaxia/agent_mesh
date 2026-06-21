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

const daemonOutLog = join(deployRoot, 'daemon.out.log');
const daemonErrLog = join(deployRoot, 'daemon.err.log');
const scheduleStatePath = join(deployRoot, '.agent-mesh', 'schedule-state.json');

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

  // 1. Daemon stdout log
  const daemonLogText = readText(daemonOutLog);
  const daemonLogIssues = scanDaemonLog(daemonLogText, { sinceIso });

  // 2. Daemon stderr log growth
  const currErrBytes = fileBytes(daemonErrLog);
  // On first run: baseline to current size — no false positive for pre-existing stderr
  const effectivePrevErrBytes = prevErrBytes !== null ? prevErrBytes : currErrBytes;
  const errLogIssues = scanErrLog(effectivePrevErrBytes, currErrBytes);

  // 3. Schedule state
  const scheduleState = (() => {
    try { return JSON.parse(readFileSync(scheduleStatePath, 'utf8')); } catch { return {}; }
  })();
  const scheduleIssues = scanScheduleState(scheduleState, 'research-escalation');

  // 4. Stranded escalations via GitHub
  const strandedIssues = await collectStrandedEscalations(repo, nowIso);

  // -------------------------------------------------------------------------
  // Advance clock
  // -------------------------------------------------------------------------
  const foundIssues = [...daemonLogIssues, ...errLogIssues, ...scheduleIssues, ...strandedIssues];
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
