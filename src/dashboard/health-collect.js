// src/dashboard/health-collect.js — the thin impure SHELL for the Health view.
//
// Reads the artifacts already on disk (manifest, run logs, schedule state,
// heartbeat snapshot, board tasks, activity events, agent-folder byte sizes,
// daemon-log freshness, daily-report digest), assembles the raw inputs, and
// hands them to the PURE buildHealthReport. NO classification logic lives here.
//
// Every read is try/degrade: a missing or corrupt file becomes empty/neutral,
// never an exception — so /api/health never 500s on a half-set-up mesh.
//
// Spec: docs/superpowers/specs/2026-06-21-mesh-health-vitals-view-design.md

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readManifest } from '../builder/manifest.js';
import { readRunLogRecords, dedupeRunRecords } from '../log.js';
import { listAllSchedules } from '../schedule/list-all.js';
import { readActivity } from '../activity-log/log.js';
import { createMeshHealth } from '../mesh-health/core.js';
import { resolveHealthThresholds } from '../config.js';
import { buildHealthReport } from './health-model.js';

async function fileSize(path) {
  try { return (await stat(path)).size; } catch { return 0; }
}

// Newest of any run ts in the window — also feeds the per-agent run list.
async function readAgentRuns(agentRoot, cutoffMs) {
  const logDir = join(agentRoot, '.agent-mesh', 'logs');
  let files = [];
  try { files = (await readdir(logDir)).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
    // Skip files whose whole day ends before the window (fast path).
    if (m && new Date(`${m[1]}T23:59:59.999Z`).getTime() < cutoffMs) continue;
    try {
      for (const r of dedupeRunRecords(await readRunLogRecords(join(logDir, f)))) {
        out.push({ started_at: r.started_at ?? null, finished_at: r.finished_at ?? null, state: r.state ?? null, status: r.status ?? null });
      }
    } catch { /* corrupt file → skip */ }
  }
  return out;
}

// Cognition byte-sizes: prompt material (AGENT.md + CLAUDE.md) and the memory
// long/short split by the project's memory-dir convention (memory/quick.json =
// short-term, memory/learned.md + memory/decisions.md = long-term).
async function readCognition(agentRoot) {
  const [agentMd, claudeMd, quick, learned, decisions] = await Promise.all([
    fileSize(join(agentRoot, 'AGENT.md')),
    fileSize(join(agentRoot, 'CLAUDE.md')),
    fileSize(join(agentRoot, 'memory', 'quick.json')),
    fileSize(join(agentRoot, 'memory', 'learned.md')),
    fileSize(join(agentRoot, 'memory', 'decisions.md')),
  ]);
  return {
    promptBytes: agentMd + claudeMd,
    memoryShortBytes: quick,
    memoryLongBytes: learned + decisions,
    headroomPct: null,   // best-effort future hook (live token headroom); null → no flag
  };
}

/**
 * collectHealth({ meshRoot, env, now }) → HealthReport (the pure model's output).
 *
 * meshRoot is the served mesh root; sibling .dev-society/ holds the heartbeat
 * snapshot, activity log, and daily-report digest. Fully tolerant — on a totally
 * empty mesh it returns a valid nominal report.
 */
export async function collectHealth({ meshRoot, env = process.env, now = Date.now() } = {}) {
  const th = resolveHealthThresholds(env);
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const cutoffMs = nowMs - th.historyDays * 86_400_000;
  const societyDir = env.AGENT_MESH_ACTIVITY_DIR || resolve(meshRoot, '..', '.dev-society');

  // Manifest → agent list (tolerant: no manifest → no agents).
  let manifestAgents = [];
  try { manifestAgents = (await readManifest(meshRoot)).agents || []; }
  catch { manifestAgents = []; }

  // Schedules → per-agent schedule state + hasEnabledJobs.
  const scheduleStates = {};
  const enabledByAgent = {};
  try {
    const { jobs } = await listAllSchedules({ meshRoot });
    for (const j of jobs || []) {
      (scheduleStates[j.agent] ||= {})[j.id] = {
        lastRunAt: j.lastRunAt ?? null, lastStatus: j.lastStatus ?? null,
        nextRunAt: j.nextRunAt ?? null, running: !!j.running,
        consecutiveFailures: j.consecutiveFailures ?? 0, enabled: !!j.enabled,
      };
      if (j.enabled) enabledByAgent[j.agent] = true;
    }
  } catch { /* no schedules → none */ }

  const agents = [];
  const perAgentRuns = {};
  const cognition = {};
  for (const a of manifestAgents) {
    if (!a || !a.name) continue;
    const agentRoot = resolve(meshRoot, a.root || a.name);
    agents.push({ name: a.name, served: a.served !== false, hasEnabledJobs: !!enabledByAgent[a.name] });
    perAgentRuns[a.name] = await readAgentRuns(agentRoot, cutoffMs);
    cognition[a.name] = await readCognition(agentRoot);
  }

  // Heartbeat snapshot.
  let heartbeat = {};
  try {
    const file = env.AGENT_MESH_HEARTBEAT_FILE || join(societyDir, 'heartbeat.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object') heartbeat = parsed;
  } catch { /* missing/corrupt → empty */ }

  // Daemon heart: heartbeat.generatedAt is the last tick; daemon.log mtime backs it.
  let logMtime = null;
  try { logMtime = (await stat(join(societyDir, 'daemon.log'))).mtime.toISOString(); } catch { /* none */ }
  const daemon = { lastTickAt: heartbeat.generatedAt ?? null, logMtime };

  // Board stale tasks (reuses the mesh-health core; reads board files only, no spawn).
  let boardStaleTasks = [];
  try {
    const res = await createMeshHealth({ meshRoot, env }).listStaleTasks({});
    if (Array.isArray(res?.tasks)) boardStaleTasks = res.tasks;
  } catch { /* no board → none */ }

  // Activity events (windowed; newest-first).
  let activityEvents = [];
  try {
    activityEvents = readActivity({ dir: societyDir, since: new Date(cutoffMs).toISOString(), limit: 500 })
      .map((e) => ({ ts: e.ts, agent: e.agent ?? null, type: e.type ?? null, level: e.level ?? 'info', summary: e.summary ?? '' }));
  } catch { /* none */ }

  // Pipeline digest (best-effort counts from the latest daily report).
  let pipeline = {};
  try {
    const report = JSON.parse(await readFile(join(societyDir, 'daily-report.json'), 'utf8'));
    pipeline = {
      openIssues: report?.issues?.open ?? null,
      openPRs: report?.prs?.open ?? null,
      drainTrend: null,
      conformance: null,
    };
  } catch { /* no digest → empty */ }

  return buildHealthReport({
    now: nowMs, thresholds: th,
    agents, perAgentRuns, scheduleStates, heartbeat, boardStaleTasks, activityEvents, cognition, daemon, pipeline,
  });
}
