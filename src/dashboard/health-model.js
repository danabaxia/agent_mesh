// src/dashboard/health-model.js — the PURE heart of the Mesh "Vital Signs" view.
//
// Given raw artifacts already assembled from disk (run logs, schedule state,
// heartbeat snapshot, board tasks, activity events, cognition byte-sizes, daemon
// log freshness, pipeline digest), classify the mesh's "biological functions"
// and emit a structured HealthReport plus a human-readable doctor's report.
//
// NO I/O. `now` is injected. Every input is optional → a neutral, empty-but-valid
// report (the collector and /api/health route own all file reads + degradation).
//
// Spec: docs/superpowers/specs/2026-06-21-mesh-health-vitals-view-design.md
//
//   buildHealthReport(input) => HealthReport
//   renderHealthReport(model) => string   (markdown "doctor's report")
//
// The honesty rule (no false "dead" alarms): a mechanism is reported DEAD only
// when something that SHOULD be beating has demonstrably stopped — a job-bearing
// agent silent past agentDeadMs, a stuck/overdue scheduled job, a stale daemon
// heart, a stuck board handoff. An idle on-demand agent (no expected cadence) is
// shown as `idle`, never `dead`.

import { resolveHealthThresholds } from '../config.js';

// Liveness precedence, worst → best. Lower index = worse.
const LIVENESS_ORDER = ['dead', 'stuck', 'failing', 'overdue', 'idle', 'alive', 'unknown'];
// Which liveness states roll an organ to critical vs warn.
const CRITICAL_LIVENESS = new Set(['dead', 'stuck']);
const WARN_LIVENESS = new Set(['failing', 'overdue']);
// Job-condition → liveness (heartbeat findings reuse these condition strings).
const CONDITION_LIVENESS = { stuck: 'stuck', failing: 'failing', overdue: 'overdue' };

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function worseLiveness(a, b) {
  const ia = LIVENESS_ORDER.indexOf(a); const ib = LIVENESS_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) <= (ib < 0 ? 99 : ib) ? a : b;
}

// 'ok' < 'warn' < 'critical' — return the worst of two organ statuses.
const STATUS_RANK = { ok: 0, warn: 1, critical: 2, unknown: -1 };
function worseStatus(a, b) {
  return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b;
}

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Build the oldest→newest list of UTC date keys for the history window.
function historyDays(nowMs, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(nowMs - i * 86_400_000));
  return out;
}

/**
 * Classify a single agent's passive liveness.
 *  - heartbeat finding for the agent → that condition's liveness (stuck/failing/overdue),
 *    escalated to `dead` when overdue AND silent past agentDeadMs.
 *  - no finding → alive if seen within agentStaleMs; else idle; a job-bearing agent
 *    silent past agentDeadMs becomes `dead` (a known cadence that fully stopped).
 *  - never `dead` for a jobless on-demand agent (no cadence to miss).
 */
function classifyLiveness({ hasEnabledJobs, lastSeenMs, worstCondition, nowMs, th }) {
  const silence = Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : Infinity;
  if (worstCondition) {
    const base = CONDITION_LIVENESS[worstCondition] || 'overdue';
    if (base === 'overdue' && hasEnabledJobs && silence >= th.agentDeadMs) return 'dead';
    return base;
  }
  if (!Number.isFinite(lastSeenMs)) {
    // never seen: only call it dead if it has a cadence it should have run by now
    return hasEnabledJobs ? 'idle' : 'unknown';
  }
  if (silence < th.agentStaleMs) return 'alive';
  if (hasEnabledJobs && silence >= th.agentDeadMs) return 'dead';
  return 'idle';
}

function livenessStatus(liveness) {
  if (CRITICAL_LIVENESS.has(liveness)) return 'critical';
  if (WARN_LIVENESS.has(liveness)) return 'warn';
  return 'ok';
}

function buildCognition(stats, th) {
  const promptBytes = Number(stats.promptBytes) || 0;
  const memoryShortBytes = Number(stats.memoryShortBytes) || 0;
  const memoryLongBytes = Number(stats.memoryLongBytes) || 0;
  const headroomPct = (typeof stats.headroomPct === 'number') ? stats.headroomPct : null;
  const hasMemory = memoryShortBytes > 0 || memoryLongBytes > 0;
  const memorySeparation = memoryShortBytes > 0 && memoryLongBytes > 0;
  const flags = [];
  if (promptBytes > th.promptSoftBytes) flags.push('prompt_oversize');
  if (headroomPct != null && headroomPct < th.headroomWarnPct) flags.push('low_headroom');
  if (hasMemory && !memorySeparation) flags.push('no_memory_separation');
  return {
    promptBytes, memoryShortBytes, memoryLongBytes, headroomPct,
    memorySeparation, flags,
    lastRotateAt: stats.lastRotateAt ?? null,
    lastDigestAt: stats.lastDigestAt ?? null,
  };
}

export function buildHealthReport(input = {}) {
  const {
    now = Date.now(),
    agents = [],
    perAgentRuns = {},
    scheduleStates = {},
    heartbeat = {},
    boardStaleTasks = [],
    activityEvents = [],
    cognition = {},
    daemon = {},
    pipeline = {},
  } = input;
  const th = input.thresholds || resolveHealthThresholds(input.env || {});
  const nowMs = toMs(now) || Date.now();

  // Group heartbeat findings by agent → worst condition for that agent.
  const findings = Array.isArray(heartbeat.findings) ? heartbeat.findings : [];
  const worstByAgent = {};
  for (const f of findings) {
    if (!f || !f.agent) continue;
    const liv = CONDITION_LIVENESS[f.condition];
    if (!liv) continue;
    worstByAgent[f.agent] = worseLiveness(worstByAgent[f.agent] || 'alive', liv);
  }

  const days = historyDays(nowMs, th.historyDays);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const perAgentHist = {};

  const counts = { alive: 0, idle: 0, overdue: 0, stuck: 0, failing: 0, dead: 0, unknown: 0 };
  const agentVitals = [];

  for (const a of agents) {
    const name = a.name;
    const runs = Array.isArray(perAgentRuns[name]) ? perAgentRuns[name] : [];
    // last seen = newest of any run ts and the agent's schedule lastRunAt.
    let lastSeenMs = NaN;
    const bumpSeen = (v) => { const m = toMs(v); if (Number.isFinite(m) && (!Number.isFinite(lastSeenMs) || m > lastSeenMs)) lastSeenMs = m; };
    const hist = new Array(days.length).fill(0);
    let recentRuns = 0; let recentFailures = 0;
    for (const r of runs) {
      bumpSeen(r.finished_at); bumpSeen(r.started_at);
      const startMs = toMs(r.started_at);
      if (Number.isFinite(startMs)) {
        const idx = dayIndex.get(utcDay(startMs));
        if (idx != null) { hist[idx] += 1; recentRuns += 1; }
        const failed = r.state === 'done' && typeof r.status === 'string' && r.status !== 'done' && r.status !== 'completed';
        if (failed && idx != null) recentFailures += 1;
      }
    }
    const sched = scheduleStates[name] || {};
    let hasEnabledJobs = !!a.hasEnabledJobs;
    for (const s of Object.values(sched)) {
      if (s && typeof s === 'object') { bumpSeen(s.lastRunAt); if (s.enabled) hasEnabledJobs = true; }
    }
    perAgentHist[name] = hist;

    const liveness = classifyLiveness({ hasEnabledJobs, lastSeenMs, worstCondition: worstByAgent[name], nowMs, th });
    counts[liveness] = (counts[liveness] ?? 0) + 1;

    agentVitals.push({
      name,
      liveness,
      lastSeenAt: Number.isFinite(lastSeenMs) ? new Date(lastSeenMs).toISOString() : null,
      silenceMs: Number.isFinite(lastSeenMs) ? nowMs - lastSeenMs : null,
      recentRuns,
      recentFailures,
      expectedCadence: hasEnabledJobs,
      cognition: buildCognition(cognition[name] || {}, th),
    });
  }

  // ── Organs ───────────────────────────────────────────────────────────────
  // Agents
  let agentsStatus = 'ok';
  for (const v of agentVitals) agentsStatus = worseStatus(agentsStatus, livenessStatus(v.liveness));

  // Jobs & daemon
  const hbSummary = heartbeat.summary || { ok: 0, failing: 0, overdue: 0, stuck: 0, escalated: 0 };
  const daemonTickMs = toMs(daemon.lastTickAt) ;
  const daemonLogMs = toMs(daemon.logMtime);
  const daemonFreshMs = Math.max(Number.isFinite(daemonTickMs) ? daemonTickMs : -Infinity,
    Number.isFinite(daemonLogMs) ? daemonLogMs : -Infinity);
  const daemonKnown = Number.isFinite(daemonFreshMs);
  const daemonSilence = daemonKnown ? nowMs - daemonFreshMs : Infinity;
  const daemonAlive = daemonKnown && daemonSilence < th.daemonStaleMs;
  let jobsStatus = 'ok';
  if ((hbSummary.stuck || 0) > 0 || (daemonKnown && !daemonAlive)) jobsStatus = 'critical';
  else if ((hbSummary.failing || 0) > 0 || (hbSummary.overdue || 0) > 0) jobsStatus = 'warn';

  // Board
  const staleTasks = Array.isArray(boardStaleTasks) ? boardStaleTasks : [];
  const boardStatus = staleTasks.length > 0 ? 'warn' : 'ok';

  // Pipeline & conformance
  const conformanceOk = pipeline.conformance == null ? null : !!pipeline.conformance.ok;
  let pipelineStatus = 'ok';
  if (pipeline.drainTrend === 'stalled' || conformanceOk === false) pipelineStatus = 'warn';

  // Cognition
  let cognitionStatus = 'ok';
  const cogFlagged = agentVitals.filter((v) => v.cognition.flags.length > 0);
  if (cogFlagged.length > 0) cognitionStatus = 'warn';

  const organs = {
    agents: { status: agentsStatus, counts },
    jobs: {
      status: jobsStatus,
      daemonAlive: daemonKnown ? daemonAlive : null,
      daemonLastSeen: Number.isFinite(daemonFreshMs) ? new Date(daemonFreshMs).toISOString() : null,
      summary: hbSummary,
      findings,                                   // backward-compat for the old Graph-view panel
      openEscalations: Array.isArray(heartbeat.openEscalations) ? heartbeat.openEscalations : [],
    },
    board: { status: boardStatus, staleTasks },
    pipeline: {
      status: pipelineStatus,
      openIssues: pipeline.openIssues ?? null,
      openPRs: pipeline.openPRs ?? null,
      drainTrend: pipeline.drainTrend ?? null,
      conformance: pipeline.conformance ?? null,
    },
    cognition: {
      status: cognitionStatus,
      flagged: cogFlagged.map((v) => ({ name: v.name, flags: v.cognition.flags })),
    },
  };

  let overall = 'ok';
  for (const o of Object.values(organs)) overall = worseStatus(overall, o.status);
  const overallLabel = overall === 'critical' ? 'critical' : overall === 'warn' ? 'warn' : 'nominal';

  // Activity event feed: newest-first, capped.
  const events = [...activityEvents]
    .filter((e) => e && (e.ts || e.timestamp))
    .map((e) => ({ ts: e.ts || e.timestamp, agent: e.agent ?? null, type: e.type ?? null, level: e.level ?? 'info', summary: e.summary ?? '' }))
    .sort((a, b) => (toMs(b.ts) || 0) - (toMs(a.ts) || 0))
    .slice(0, 100);

  const model = {
    generatedAt: new Date(nowMs).toISOString(),
    overall: overallLabel,
    organs,
    agentVitals,
    activityHistory: { days, perAgent: perAgentHist, events },
  };
  model.report = { markdown: renderHealthReport(model) };
  // Backward-compat: keep the old /api/health top-level keys reachable so the
  // existing Graph-view Health panel keeps working unchanged.
  model.summary = hbSummary;
  model.findings = findings;
  model.openEscalations = organs.jobs.openEscalations;
  return model;
}

const ORGAN_LABEL = { agents: 'Agents', jobs: 'Jobs & Daemon', board: 'Task Board', pipeline: 'Pipeline & Conformance', cognition: 'Cognition' };
const STATUS_MARK = { ok: '🟢 ok', warn: '🟡 warn', critical: '🔴 CRITICAL', unknown: '⚪ unknown' };

/**
 * renderHealthReport(model) — a plain doctor's report a human can read top to
 * bottom. Deterministic; pure string assembly from the model.
 */
export function renderHealthReport(model) {
  if (!model || typeof model !== 'object') return '# Mesh health\n\n_no data_\n';
  const L = [];
  const verdict = model.overall === 'critical' ? '🔴 CRITICAL — dead mechanism(s) detected'
    : model.overall === 'warn' ? '🟡 Attention needed' : '🟢 All systems nominal';
  L.push(`# Mesh Vital Signs — ${verdict}`);
  L.push('');
  L.push(`_generated ${model.generatedAt}_`);
  L.push('');

  L.push('## Organs');
  for (const [key, label] of Object.entries(ORGAN_LABEL)) {
    const o = model.organs?.[key]; if (!o) continue;
    L.push(`- **${label}** — ${STATUS_MARK[o.status] || o.status}`);
  }
  L.push('');

  // Dead / impaired mechanisms called out explicitly (the "no dead mechanism" check).
  const dead = (model.agentVitals || []).filter((v) => v.liveness === 'dead' || v.liveness === 'stuck');
  const warnAgents = (model.agentVitals || []).filter((v) => v.liveness === 'failing' || v.liveness === 'overdue');
  L.push('## Liveness');
  if (dead.length === 0 && warnAgents.length === 0) {
    L.push('No dead or impaired agent mechanisms detected.');
  } else {
    for (const v of dead) L.push(`- 🔴 **${v.name}** — ${v.liveness}${v.lastSeenAt ? ` (last seen ${v.lastSeenAt})` : ' (never seen)'}`);
    for (const v of warnAgents) L.push(`- 🟡 **${v.name}** — ${v.liveness}`);
  }
  const jobs = model.organs?.jobs;
  if (jobs && jobs.daemonAlive === false) L.push(`- 🔴 **daemon** — heart stopped (last tick ${jobs.daemonLastSeen || 'unknown'})`);
  L.push('');

  const stale = model.organs?.board?.staleTasks || [];
  if (stale.length) {
    L.push('## Stuck handoffs');
    for (const t of stale) L.push(`- task \`${t.id}\` ${t.from || '?'}→${t.to || '?'} stuck in ${t.state} (${Math.round((t.age_ms || 0) / 3_600_000)}h)`);
    L.push('');
  }

  const flagged = model.organs?.cognition?.flagged || [];
  if (flagged.length) {
    L.push('## Cognition flags');
    for (const f of flagged) L.push(`- **${f.name}** — ${f.flags.join(', ')}`);
    L.push('');
  }

  return L.join('\n') + '\n';
}
