/**
 * src/schedule/scheduler.js — Mesh scheduler (Phase-5 Task 2, spec §3.3).
 *
 * Per-agent recurring jobs executed as real ask-mode delegations on a timer.
 *
 *   createScheduler({ meshRoot, runJob?, intervalMs=30000, now? })
 *     → { start(), stop(), tick(), runNow(agent,id), setEnabled(agent,id,bool), list(agent) }
 *
 * Storage:
 *   - Job definitions (intent, git-tracked with the agent):
 *       <agentRoot>/.agent/schedule.json
 *       { jobs: [{ id, name, prompt, cadence, enabled, saveArtifact }] }
 *   - Runtime state (never in git):
 *       <agentRoot>/.agent-mesh/schedule-state.json
 *       { [jobId]: { lastRunAt, lastStatus:'ok'|'fail', lastSummary, nextRunAt, running } }
 *   Both files are tolerated when missing/corrupt (treated as empty).
 *
 * Due rule: enabled && !running && nextRunAt ≤ now. A never-run job gets its
 * first nextRunAt computed on first tick (NOT run immediately); a job whose
 * nextRunAt was missed while the dashboard was down runs ONCE at the next tick
 * and is then rescheduled from now (no catch-up burst). One job at a time per
 * agent — the concurrency lock is an in-memory Set of agent names; a persisted
 * running:true with no in-memory lock is a stale crash leftover and is cleared.
 *
 * runJob contract: async ({ agentRoot, agentName, job }) →
 *   { status:'ok'|'fail', output?:string, error?:string }; rejection = fail.
 * The default runJob wraps delegateTask (ask mode, route 'scheduled:<id>'),
 * mirroring the serve-a2a worker env (AGENT_MESH_MESH_ROOT=<meshRoot>/mesh,
 * AGENT_MESH_MESH_CEILING=<meshRoot>, AGENT_MESH_ENABLED_MODES='ask' over
 * process.env). delegateTask result mapping (src/delegate.js):
 *   status 'done'                       → ok, output = result.summary
 *   'timeout' | 'error' | 'refused' | * → fail, error = error.message/summary
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { readManifest } from '../builder/manifest.js';
import { computeNextRun } from './schedule-cadence.js';
import { delegateTask } from '../delegate.js';

const DEFAULT_INTERVAL_MS = 30_000;
const SUMMARY_CAP = 200;                 // lastSummary chars
const ARTIFACT_CONTENT_CAP = 64 * 1024;  // saveArtifact source.content bytes-ish (chars)

// ---------------------------------------------------------------------------
// Tolerant JSON file helpers
// ---------------------------------------------------------------------------

async function readJson(path, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const defsPath  = (agentRoot) => join(agentRoot, '.agent', 'schedule.json');
const statePath = (agentRoot) => join(agentRoot, '.agent-mesh', 'schedule-state.json');

async function loadDefs(agentRoot) {
  const raw = await readJson(defsPath(agentRoot), { jobs: [] });
  return Array.isArray(raw.jobs) ? raw.jobs : [];
}

const loadState = (agentRoot) => readJson(statePath(agentRoot), {});

// ---------------------------------------------------------------------------
// Default runJob — real ask-mode delegation through delegateTask
// ---------------------------------------------------------------------------

function createDelegateRunJob(meshRoot) {
  return async ({ agentRoot, job }) => {
    // Mirror the serve-a2a worker env (src/builder/manifest.js peer entries /
    // src/dashboard/console.js): mesh root + ceiling + ask-only policy.
    const env = {
      ...process.env,
      AGENT_MESH_MESH_ROOT: join(meshRoot, 'mesh'),
      AGENT_MESH_MESH_CEILING: meshRoot,
      AGENT_MESH_ENABLED_MODES: 'ask'
    };
    const result = await delegateTask({
      root: agentRoot,
      env,
      input: { mode: 'ask', task: job.prompt },
      route: `scheduled:${job.id}`
    });
    // delegateTask contract: 'done' is the only success status; 'timeout',
    // 'error' and 'refused' all carry error/summary detail.
    if (result?.status === 'done') {
      return { status: 'ok', output: result.summary ?? '' };
    }
    const detail = result?.error?.message || result?.summary || '';
    return { status: 'fail', error: `${result?.status ?? 'unknown'}${detail ? `: ${detail}` : ''}` };
  };
}

// ---------------------------------------------------------------------------
// saveArtifact — Phase-3 LOCKED storage contract (mirrors the POST
// /api/agent/:name/artifacts route in server.js: id stamp+slug with -2/-3
// collision suffixes, context.json shape, artifact.md `# title` + provenance).
// ---------------------------------------------------------------------------

function artifactSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

async function saveJobArtifact({ agentRoot, agentName, job, output, when }) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const dateStr = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
  const title = `${job.name} — ${dateStr}`;
  const stamp = `${dateStr}-${pad2(when.getHours())}${pad2(when.getMinutes())}`;
  const baseId = `${stamp}-${artifactSlug(title) || 'artifact'}`;

  const artifactsRoot = join(agentRoot, '.agent', 'artifacts');
  let id = baseId;
  for (let n = 2; ; n += 1) {
    const exists = await stat(join(artifactsRoot, id)).then(() => true, () => false);
    if (!exists) break;
    id = `${baseId}-${n}`;
  }

  const content = String(output ?? '').slice(0, ARTIFACT_CONTENT_CAP);
  const context = {
    title,
    type: 'report',
    task: job.name,
    inputs: [],
    frame: [],
    source: { kind: 'text', content },
    agent: agentName,
    savedAt: when.toISOString(),
    sessionId: null,
    promotedTo: null
  };

  const dir = join(artifactsRoot, id);
  await mkdir(dir, { recursive: true });
  const provenance = `> saved ${context.savedAt} · agent: ${agentName} · type: report · task: ${job.name}`;
  await writeFile(join(dir, 'context.json'), JSON.stringify(context, null, 2) + '\n', 'utf8');
  await writeFile(join(dir, 'artifact.md'), `# ${title}\n\n${provenance}\n\n${content}\n`, 'utf8');
  return id;
}

// ---------------------------------------------------------------------------
// createScheduler
// ---------------------------------------------------------------------------

export function createScheduler({ meshRoot, runJob, intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date() }) {
  const root = resolve(meshRoot);
  const run = runJob || createDelegateRunJob(root);
  const runningAgents = new Set();   // in-memory one-job-at-a-time lock, per agent
  let timer = null;

  async function agents() {
    let manifest;
    try { manifest = await readManifest(root); } catch { return []; }
    const list = Array.isArray(manifest?.agents) ? manifest.agents : [];
    return list
      .filter((a) => a && typeof a.name === 'string' && typeof a.root === 'string')
      .map((a) => ({ name: a.name, root: resolve(join(root, a.root)) }));
  }

  async function findAgent(name) {
    return (await agents()).find((a) => a.name === name) || null;
  }

  /** Execute one job under the agent lock; never throws. Caller checked the lock. */
  async function executeJob(agent, job) {
    runningAgents.add(agent.name);
    const startedAt = now();
    try {
      // Mark running (persisted so list()/the tab can show ▶ running).
      const state = await loadState(agent.root);
      state[job.id] = { ...state[job.id], running: true };
      await writeJson(statePath(agent.root), state);

      let ok = false;
      let summarySource = '';
      let output = '';
      try {
        const result = await run({ agentRoot: agent.root, agentName: agent.name, job });
        ok = result?.status === 'ok';
        output = typeof result?.output === 'string' ? result.output : '';
        summarySource = ok ? output : (result?.error || result?.output || `status: ${result?.status ?? 'unknown'}`);
      } catch (err) {
        ok = false;
        summarySource = err?.message || String(err);
      }

      const finishedAt = now();
      if (ok && job.saveArtifact) {
        try { await saveJobArtifact({ agentRoot: agent.root, agentName: agent.name, job, output, when: finishedAt }); }
        catch { /* artifact write failure must not flip a successful run */ }
      }

      const after = await loadState(agent.root);
      after[job.id] = {
        lastRunAt: startedAt.toISOString(),
        lastStatus: ok ? 'ok' : 'fail',
        lastSummary: String(summarySource).slice(0, SUMMARY_CAP),
        nextRunAt: computeNextRun(job.cadence, finishedAt).toISOString(),
        running: false
      };
      await writeJson(statePath(agent.root), after);
    } catch { /* state IO failure — swallow; next tick retries */ }
    finally { runningAgents.delete(agent.name); }
  }

  async function tickAgent(agent) {
    if (runningAgents.has(agent.name)) return;   // one job at a time per agent
    const jobs = await loadDefs(agent.root);
    if (jobs.length === 0) return;

    const state = await loadState(agent.root);
    const nowDate = now();
    let stateDirty = false;
    let dueJob = null;

    for (const job of jobs) {
      if (!job || typeof job.id !== 'string' || !job.cadence) continue;
      const entry = state[job.id];
      // Stale crash leftover: persisted running with no in-memory lock.
      if (entry?.running) { entry.running = false; stateDirty = true; }
      if (!entry || !entry.nextRunAt) {
        // Never-run job: compute its first nextRunAt; do NOT run now.
        state[job.id] = { ...entry, nextRunAt: computeNextRun(job.cadence, nowDate).toISOString(), running: false };
        stateDirty = true;
        continue;
      }
      if (!dueJob && job.enabled && Date.parse(entry.nextRunAt) <= nowDate.getTime()) {
        dueJob = job;
      }
    }

    if (stateDirty) await writeJson(statePath(agent.root), state);
    if (dueJob) await executeJob(agent, dueJob);   // missed-while-down → runs ONCE here
  }

  async function tick() {
    for (const agent of await agents()) {
      try { await tickAgent(agent); } catch { /* never throw out of tick */ }
    }
  }

  async function runNow(agentName, jobId) {
    const agent = await findAgent(agentName);
    if (!agent) return { ok: false, reason: 'unknown_agent' };
    const job = (await loadDefs(agent.root)).find((j) => j && j.id === jobId);
    if (!job) return { ok: false, reason: 'unknown_job' };
    if (runningAgents.has(agent.name)) return { ok: false, reason: 'running' };
    await executeJob(agent, job);    // bypasses enabled + nextRunAt, not the lock
    return { ok: true };
  }

  async function setEnabled(agentName, jobId, enabled) {
    const agent = await findAgent(agentName);
    if (!agent) return { ok: false, reason: 'unknown_agent' };
    const defs = await readJson(defsPath(agent.root), { jobs: [] });
    const jobs = Array.isArray(defs.jobs) ? defs.jobs : [];
    const job = jobs.find((j) => j && j.id === jobId);
    if (!job) return { ok: false, reason: 'unknown_job' };
    job.enabled = !!enabled;
    await writeJson(defsPath(agent.root), { ...defs, jobs });
    if (enabled) {
      // Re-enabling reschedules from now — a long pause must not cause an
      // immediate catch-up run.
      const state = await loadState(agent.root);
      state[jobId] = { ...state[jobId], nextRunAt: computeNextRun(job.cadence, now()).toISOString(), running: false };
      await writeJson(statePath(agent.root), state);
    }
    return { ok: true };
  }

  async function list(agentName) {
    const agent = await findAgent(agentName);
    if (!agent) return [];
    const jobs = await loadDefs(agent.root);
    const state = await loadState(agent.root);
    return jobs
      .filter((j) => j && typeof j.id === 'string')
      .map((job) => {
        const entry = state[job.id] || {};
        return {
          id: job.id,
          name: job.name ?? job.id,
          prompt: job.prompt ?? '',
          cadence: job.cadence ?? null,
          enabled: !!job.enabled,
          saveArtifact: !!job.saveArtifact,
          lastRunAt: entry.lastRunAt ?? null,
          lastStatus: entry.lastStatus ?? null,
          lastSummary: entry.lastSummary ?? '',
          nextRunAt: entry.nextRunAt ?? null,
          running: runningAgents.has(agent.name) && !!entry.running
        };
      });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    tick().catch(() => {});            // immediate first tick
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, tick, runNow, setEnabled, list };
}
