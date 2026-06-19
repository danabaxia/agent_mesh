import { readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  DEFAULT_DEPTH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LOG_DIR,
  WRITE_TOOLS,
  readPositiveInt
} from './config.js';
import { readLayer } from './settings-merge.js';
import { validateDelegateInput } from './contract.js';
import { enterCallContext } from './context.js';
import { captureChangeState, computeFilesChanged } from './change-detect.js';
import { badInput, refused, resultError } from './errors.js';
import { createRunLog, appendRunLog, readRunLogRecords } from './log.js';
import { spawnFile } from './process.js';
import {
  buildClaudeInvocation, buildClaudeEnv, compactArgv
} from './delegate-invocation.js';
import { recordEvent } from './session-provenance.js';
import { readManifest, writeManifest, upsertSession } from './session-manifest.js';

export { resolveMeshRoot } from './delegate-invocation.js';

// Managed-settings paths inspected by the preflight. Each entry is a candidate
// JSON file or directory; presence is best-effort (missing → skipped).
const MANAGED_PATHS_BY_PLATFORM = {
  darwin: [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/Library/Application Support/ClaudeCode/managed-settings.d',
  ],
  linux: [
    '/etc/claude-code/managed-settings.json',
    '/etc/claude-code/managed-settings.d',
  ],
};

function managedPathsFor(env, platform) {
  const override = env?.AGENT_MESH_TEST_MANAGED_FILE;
  if (override) return [override];
  return MANAGED_PATHS_BY_PLATFORM[platform] || [];
}

async function inspectManagedPolicyDocs(env, platform) {
  const docs = [];
  for (const p of managedPathsFor(env, platform)) {
    try {
      const s = await stat(p);
      if (s.isFile()) {
        const r = await readLayer(p);
        if (r.ok) docs.push(r.value);
      } else if (s.isDirectory()) {
        const files = await readdir(p);
        for (const f of files.sort()) {
          if (!f.endsWith('.json')) continue;
          const r = await readLayer(join(p, f));
          if (r.ok) docs.push(r.value);
        }
      }
    } catch { /* missing or unreadable → skip silently */ }
  }
  return docs;
}

function managedPolicyBlocksMeshHook(doc) {
  if (doc?.disableAllHooks === true) return 'disableAllHooks';
  if (doc?.allowManagedHooksOnly === true) return 'allowManagedHooksOnly';
  const entries = doc?.hooks?.PreToolUse;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const m = String(e?.matcher || '');
      if (WRITE_TOOLS.some((t) => m.includes(t))) return 'overlapping_PreToolUse';
    }
  }
  return null;
}

async function preflightManagedPolicy(env, platform) {
  if (platform === 'win32') {
    if (env?.AGENT_MESH_ATTEST_MANAGED_COMPATIBLE === '1') return null;
    return {
      reason: 'managed_policy_unverifiable_windows',
      message:
        'Windows managed-settings introspection is incomplete in v1; set AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1 to attest compatibility.',
    };
  }
  const docs = await inspectManagedPolicyDocs(env, platform);
  for (const d of docs) {
    const block = managedPolicyBlocksMeshHook(d);
    if (block) {
      return {
        reason: 'incompatible_managed_policy',
        message: `Managed policy ${block} would prevent the mesh path-guard from running.`,
      };
    }
  }
  return null;
}

export async function delegateTask({ root, env, input, parentRunId = null, route = null, session = null }) {
  const validation = validateDelegateInput(input);
  if (!validation.ok) return badInput(validation.message);

  const { mode, task } = validation.value;
  if (env.AGENT_MESH_MODE === 'ask' && mode === 'do') {
    return refused('readonly_parent', 'Refusing write delegation from a read-only parent task.');
  }

  const entered = enterCallContext(root, env, DEFAULT_DEPTH);
  if (!entered.ok) return entered.result;

  // do-mode preflight: refuse if OS-level managed settings would silently
  // disable the mesh's path-guard PreToolUse hook. ask is unaffected because
  // it has no hook to be disabled. See docs/.../settings-inheritance-design.md.
  if (mode === 'do') {
    const platform = env.AGENT_MESH_TEST_PLATFORM || process.platform;
    const blocked = await preflightManagedPolicy(env, platform);
    if (blocked) return refused(blocked.reason, blocked.message);
  }

  // Grouped per-date log file + a unique run id (start + final share it). The
  // log dir is excluded from change detection, so these records never affect
  // files_changed / preexisting_dirty.
  const { logPath, runId } = await createRunLog(root, env);
  const startedAt = new Date().toISOString();
  // START record (state:"started", no finished_at) so the dashboard can show the
  // agent as "working" mid-task; a FINAL record with the same id is appended at
  // completion (readers dedup by id, last wins).
  await appendRunLog(logPath, {
    id: runId, parent_run_id: parentRunId, route,
    started_at: startedAt, root, mode, task, state: 'started'
  });

  const timeoutMs = readPositiveInt(env.AGENT_MESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const before = await captureChangeState(root);

  // Spawn tagging (2026-06-13 spec §3): every framework spawn gets a known
  // session id so its transcript is identifiable as worker-origin — the
  // dashboard's auto-follow then never mistakes a scheduler/digest/delegate
  // run for the user's own CLI session. Framework-side only: the model-facing
  // surface stays {mode, task}. Best-effort — tagging never fails a turn.
  let taggedSession = session;
  if (!taggedSession) {
    taggedSession = { id: randomUUID(), resume: false };
    const meshRoot = env?.AGENT_MESH_MESH_CEILING;
    if (meshRoot) {
      try {
        await recordEvent(meshRoot, {
          kind: 'create', source: `worker:${route || mode}`,
          sessionId: taggedSession.id, agentRoot: root
        });
      } catch { /* provenance is observability, never load-bearing for the turn */ }
    }
  }

  // Forward-maintain the per-agent session manifest (spec §7): register this
  // framework spawn (origin worker:<route>) so the dashboard task-session list and
  // absorption see it. Lives under <root>/.agent-mesh/ → change-detection-excluded,
  // so it never pollutes files_changed. Best-effort + atomic; delegate_task is
  // per-folder-serialized by the caller's SerialQueue, so the read-modify-write
  // doesn't race within a folder. Never load-bearing for the turn.
  try {
    const manifest = await readManifest(root);
    const prior = manifest.sessions.find((s) => s.id === taggedSession.id);
    const run_ids = [...new Set([...(prior?.run_ids || []), runId])];
    await writeManifest(root, upsertSession(manifest, {
      id: taggedSession.id, origin: `worker:${route || mode}`, status: 'active', run_ids
    }));
  } catch { /* manifest is observability, never fails a turn */ }

  let spawnResult;
  let invocation;
  try {
    const claudeEnv = buildClaudeEnv({ root, env, mode, callEnv: entered.env, runId });
    invocation = await buildClaudeInvocation({ root, mode, task, env, callEnv: entered.env, claudeEnv, session: taggedSession });
    spawnResult = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', invocation.args, {
      cwd: root,
      env: claudeEnv,
      timeoutMs,
      detached: true
    });
    // Auto-updater race: npm's claude binary is briefly ABSENT while the
    // updater swaps the package (observed live 2026-06-10 AND AGAIN
    // 2026-06-12T02:42Z — a single 1.5s retry was beaten by the second
    // window). Ride it out with a backoff SCHEDULE: base, x2, x4 (default
    // 1.5s+3s+6s ≈ 10.5s of cover); a genuinely missing binary still fails.
    {
      const base = readPositiveInt(env.AGENT_MESH_SPAWN_RETRY_MS, 1500);
      const attempts = readPositiveInt(env.AGENT_MESH_SPAWN_RETRIES, 3);
      for (let i = 0; i < attempts && spawnResult.error && /ENOENT/i.test(spawnResult.error.message || ''); i++) {
        await new Promise((r) => setTimeout(r, base * 2 ** i));
        spawnResult = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', invocation.args, {
          cwd: root,
          env: claudeEnv,
          timeoutMs,
          detached: true
        });
      }
    }
    // Resume-load self-heal (§3.3/§8): a deleted/over-compacted/broken transcript
    // makes `--resume <id>` fail; retry once fresh with `--session-id <id>` so a
    // stale id never strands the caller. The deterministic id is unchanged, so the
    // next turn resumes the freshly-created transcript.
    const RESUME_FAIL = /no conversation|session not found|could not resume|--resume/i;
    if (taggedSession && taggedSession.resume && spawnResult.code !== 0 && RESUME_FAIL.test(spawnResult.stderr || '')) {
      invocation = await buildClaudeInvocation({ root, mode, task, env, callEnv: entered.env, claudeEnv,
        session: { id: taggedSession.id, resume: false } });
      spawnResult = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', invocation.args, {
        cwd: root,
        env: claudeEnv,
        timeoutMs,
        detached: true
      });
    }
  } catch (error) {
    const result = resultError('spawn_failed', error.message);
    result.log_path = logPath;
    result.run_id = runId;
    await appendRunLog(logPath, {
      id: runId,
      parent_run_id: parentRunId,
      route,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      root,
      mode,
      task,
      state: 'done',
      status: result.status,
      result
    });
    return result;
  }

  const changed = await computeFilesChanged(root, before);
  const result = buildDelegateResult({ spawnResult, changed, logPath });
  result.run_id = runId;
  // Accumulate peer_changes from any bridge a2a calls the worker made (do-mode
  // chains only). null when no bridge calls happened or mode is ask.
  if (mode === 'do') {
    const downstream = await aggregateDownstreamChanges(root, env, runId);
    if (downstream !== null) result.downstream_changes = downstream;
  }
  await appendRunLog(logPath, {
    id: runId,
    parent_run_id: parentRunId,
    route,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    root,
    mode,
    task,
    state: 'done',
    status: result.status,
    summary: result.summary,
    // Token/cost accounting parsed from the worker's --output-format json result
    // envelope; null when the output wasn't a parseable envelope (timeout/error).
    // Top-level for cheap reads (readRuns / dashboard cost views) without walking
    // into the nested `result`.
    usage: result.usage ?? null,
    // Keep grouped-file lines compact + atomic: drop the huge system-prompt body
    // from argv and tail stdout/stderr.
    argv: compactArgv(invocation.args),
    stdout: tail(spawnResult.stdout, 2000),
    stderr: tail(spawnResult.stderr, 2000),
    result
  });
  return result;
}

// Env for the framework peer bridge MCP server. The bridge inherits the worker's
// (claude's) environment for system PATH etc.; here we set only the
// security-relevant overrides:
//   - AGENT_MESH_MODE='ask'  → v1 ask-only onward (overrides the worker's mode so
//     the bridge cannot launder a `do` worker into a `do` peer call).
//   - AGENT_MESH_PATH/DEPTH  → the THREADED call context (from entered.env) so
//     peers the bridge spawns get correct cycle/depth detection.
//   - framework config pass-through (mesh root/ceiling, claude binary, timeout,
//     log dir) so peers resolve the same global layer + ceiling.

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parse the terminal result envelope from `claude -p --output-format json`.
 * Returns `{ summary, usage }` when stdout is a single JSON result object, or
 * `null` when it is not parseable as one (bare text, truncated by a timeout, a
 * non-zero-exit error string, or an older CLI that ignored the flag). The caller
 * then falls back to the raw text tail for the summary and a null `usage`.
 * `summary` is `null` when the envelope carries no string `.result` (e.g. an
 * error subtype) but a `usage` block may still be present.
 */
export function parseResultEnvelope(stdout) {
  const text = (stdout || '').trim();
  if (!text) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const hasResult = typeof obj.result === 'string';
  const u = obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  const hasUsage = obj.total_cost_usd !== undefined
    || u.input_tokens !== undefined || obj.num_turns !== undefined;
  // Require it to look like a result envelope, so a model that happens to print a
  // JSON object in TEXT mode (no --output-format) is never mistaken for one.
  if (!hasResult && !hasUsage) return null;
  return {
    summary: hasResult ? obj.result : null,
    usage: {
      input_tokens: numOrNull(u.input_tokens),
      output_tokens: numOrNull(u.output_tokens),
      cache_read_input_tokens: numOrNull(u.cache_read_input_tokens),
      cache_creation_input_tokens: numOrNull(u.cache_creation_input_tokens),
      total_cost_usd: numOrNull(obj.total_cost_usd),
      num_turns: numOrNull(obj.num_turns),
      duration_api_ms: numOrNull(obj.duration_api_ms),
      session_id: typeof obj.session_id === 'string' ? obj.session_id : null
    }
  };
}

function buildDelegateResult({ spawnResult, changed, logPath }) {
  // Parse the JSON result envelope (--output-format json). On a timeout the
  // output is truncated, so prefer summarizeSpawn's "Timed out…" framing there;
  // otherwise use the envelope's `.result` when present, else the text fallback.
  const envelope = parseResultEnvelope(spawnResult.stdout);
  const summary = !spawnResult.timedOut && envelope && envelope.summary != null
    ? tail(envelope.summary)
    : summarizeSpawn(spawnResult);
  const base = {
    summary,
    files_changed: changed.files_changed,
    log_path: logPath
  };
  if (envelope && envelope.usage) base.usage = envelope.usage;
  if (changed.preexisting_dirty) base.preexisting_dirty = true;
  if (changed.best_effort) base.best_effort = true;
  if (changed.note) base.note = changed.note;

  if (spawnResult.timedOut) {
    return {
      status: 'timeout',
      ...base
    };
  }

  if (spawnResult.error) {
    return {
      status: 'error',
      ...base,
      error: { code: 'spawn_failed', message: spawnResult.error.message }
    };
  }

  if (spawnResult.code !== 0) {
    return {
      status: 'error',
      ...base,
      error: {
        code: 'internal',
        message: spawnResult.stderr.trim() || `claude exited with code ${spawnResult.code}`
      }
    };
  }

  return {
    status: 'done',
    ...base
  };
}

function summarizeSpawn(spawnResult) {
  const text = (spawnResult.stdout || spawnResult.stderr || '').trim();
  if (spawnResult.timedOut) {
    return text ? `Timed out. Last output:\n${tail(text)}` : 'Timed out before producing output.';
  }
  return tail(text) || 'Completed without output.';
}

function tail(text, limit = 4000) {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

/**
 * After the worker finishes, read the bridge's a2a log records that were
 * written during this run (identified by parent_run_id === runId) and
 * aggregate all peer_changes arrays into a deduplicated flat list.
 *
 * Returns null when no bridge calls happened (ask chains, no bridge, etc.).
 * Returns [] when bridge calls happened but no files were changed.
 */
async function aggregateDownstreamChanges(root, env, runId) {
  const logDir = resolve(root, (env && env.AGENT_MESH_LOG_DIR) || DEFAULT_LOG_DIR);
  let files;
  try { files = await readdir(logDir); } catch { return null; }
  const a2aFiles = files.filter((f) => f.startsWith('a2a-') && f.endsWith('.jsonl')).sort();
  const allChanges = [];
  let found = false;
  for (const f of a2aFiles) {
    const records = await readRunLogRecords(join(logDir, f));
    for (const r of records) {
      if (r.parent_run_id !== runId || r.state !== 'done') continue;
      found = true;
      if (Array.isArray(r.peer_changes)) allChanges.push(...r.peer_changes);
    }
  }
  return found ? [...new Set(allChanges)] : null;
}
