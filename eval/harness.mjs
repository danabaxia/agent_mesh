// eval/harness.mjs — fixtures + A2A driver for the behavior eval suite.
// Spec: docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md
import { mkdtemp, mkdir, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { BIN_PATH } from '../src/delegate-invocation.js';
import { readRunLogRecords, dedupeRunRecords } from '../src/log.js';
import { encodeProjectDir } from '../src/session-transcripts.js';
import { createA2AClient } from '../src/a2a/stdio-client.js';

const execFileAsync = promisify(execFile);

// Tmp-dir teardown options. `force` only swallows ENOENT; it does NOT retry the
// EBUSY/ENOTEMPTY/EPERM race that git's background pack writers can lose against
// `rm` on node 20 / linux (issue #542). maxRetries+retryDelay gives a short
// linear backoff (50/100/150ms) which clears the inner .git/objects/pack races.
const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 };

/** Random ground-truth token — unguessable from world knowledge. */
export function plant(prefix = 'FACT') {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Materialize a disposable mesh.
 * agents: { NAME: { agentMd?, files?: {rel: text}, peers?: [names], env?: {} } }
 * Every agent is git-init-ed and its seed files committed (gitClean probes).
 * Agents with `peers` get a marked registry.json shaped exactly like
 * generateRegistry output (root/command/args/env incl. MESH_ROOT/CEILING).
 * Run logs go to a per-agent dir OUTSIDE the mesh (spec §5 confound note).
 */
export async function buildMesh({ agents = {}, claude, timeoutMs = 120_000 } = {}) {
  if (!claude) throw new Error('eval harness: a claude binary path is required (fake for hermetic tests, real for eval runs)');
  const meshRoot = await realpath(await mkdtemp(join(tmpdir(), 'a2a-eval-')));   // realpath: macOS /var → /private/var (identity invariant)
  const logsBase = await mkdtemp(join(tmpdir(), 'a2a-eval-logs-'));
  const out = { meshRoot, logsBase, agents: {} };
  try {
    for (const name of Object.keys(agents)) {
      const root = join(meshRoot, name);
      await mkdir(root, { recursive: true });
      out.agents[name] = { name, root, logDir: join(logsBase, name) };
    }
    await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
      'x-agentmesh-generated': true,
      meshVersion: '1',
      agents: Object.keys(agents).map((name) => ({ name, root: `./${name}` }))
    }));
    for (const [name, spec] of Object.entries(agents)) {
      const a = out.agents[name];
      if (spec.agentMd) await writeFile(join(a.root, 'AGENT.md'), spec.agentMd);
      for (const [rel, text] of Object.entries(spec.files || {})) {
        await mkdir(dirname(join(a.root, rel)), { recursive: true });
        await writeFile(join(a.root, rel), text);
      }
      // A valid peer entry for `peerName`, with optional `env` override merged on
      // top of the framework-threaded peer env. Used by both the generator and the
      // `rawRegistry` escape hatch.
      const peerEntry = (peerName, { env } = {}) => {
        const p = out.agents[peerName];
        if (!p) throw new Error(`buildMesh: agent "${name}" references unknown peer "${peerName}"`);
        return {
          root: p.root, command: process.execPath, args: [BIN_PATH, 'serve-a2a', p.root],
          cwd: p.root, env: peerEnv(out, p, claude, timeoutMs, env)
        };
      };
      if (spec.rawRegistry) {
        // Adversarial escape hatch: plant a registry.json VERBATIM (e.g. unmarked
        // for I7, or reserved-env-overriding for I5), bypassing the marker generator.
        const reg = typeof spec.rawRegistry === 'function'
          ? spec.rawRegistry({ agents: out.agents, peerEntry })
          : spec.rawRegistry;
        await writeFile(join(a.root, 'registry.json'), JSON.stringify(reg));
      } else if (Array.isArray(spec.peers) && spec.peers.length > 0) {
        const peers = {};
        for (const pn of spec.peers) peers[pn] = peerEntry(pn, { env: agents[pn]?.env });
        await writeFile(join(a.root, 'registry.json'),
          JSON.stringify({ 'x-agentmesh-generated': true, peers }));
      }
      await execFileAsync('git', ['init', '-q'], { cwd: a.root });
      await execFileAsync('git', ['add', '-A'], { cwd: a.root });
      await execFileAsync('git', [
        '-c', 'user.email=eval@local', '-c', 'user.name=eval',
        '-c', 'commit.gpgsign=false',
        'commit', '-qm', 'seed', '--allow-empty'
      ], { cwd: a.root });
    }
    return out;
  } catch (err) {
    await rm(meshRoot, RM_OPTS).catch(() => {});
    await rm(logsBase, RM_OPTS).catch(() => {});
    throw err;
  }
}

function peerEnv(mesh, agent, claude, timeoutMs, extra) {
  return {
    AGENT_MESH_ENABLED_MODES: 'ask',
    AGENT_MESH_MESH_ROOT: join(mesh.meshRoot, 'mesh'),
    AGENT_MESH_MESH_CEILING: mesh.meshRoot,
    AGENT_MESH_CLAUDE: claude,
    AGENT_MESH_LOG_DIR: agent.logDir,
    AGENT_MESH_TIMEOUT_MS: String(timeoutMs),
    ...(extra || {})
  };
}

/**
 * Drive one agent over the REAL A2A wire: spawn `serve-a2a <root>` via
 * createA2AClient and send the turns in order. Each turn carries a UNIQUE
 * `agentmesh/caller` tag so the driven agent never resumes ITS OWN thread
 * across eval turns — the only cross-turn memory channel is then the
 * peer-side `from:<agent>` session, which is exactly what scenarios 5/6
 * measure. Returns [{ answer, runId, state, errorCode, task }] per turn.
 *
 * agentEnv cannot override AGENT_MESH_PATH/AGENT_MESH_DEPTH — stdio-client
 * takes those authoritatively from the base env (recursion-state protection).
 */
export async function driveAgent(mesh, agentName, turns,
  { claude, timeoutMs = 180_000, callerTag = `eval-${randomUUID().slice(0, 8)}`, agentEnv = {} } = {}) {
  if (!claude) throw new Error('eval harness: a claude binary path is required (fake for hermetic tests, real for eval runs)');
  const a = mesh.agents[agentName];
  const registry = { peers: { [agentName]: {
    root: a.root,
    command: process.execPath,
    args: [BIN_PATH, 'serve-a2a', a.root],
    cwd: a.root,
    env: { ...peerEnv(mesh, a, claude, timeoutMs), ...agentEnv }
  } } };
  const client = await createA2AClient(registry, {
    env: process.env, requestTimeoutMs: timeoutMs + 60_000
  });
  const results = [];
  try {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const message = {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: t.task }],
        metadata: { 'agentmesh/mode': 'ask', 'agentmesh/caller': `${callerTag}-t${i}`, ...(t.metadata || {}) }
      };
      const task = await client.send(agentName, message);
      results.push(toResult(task));
    }
  } finally {
    await client.close().catch(() => {});
  }
  return results;
}

function toResult(task) {
  const answer = (task?.artifacts ?? [])
    .flatMap((a) => (Array.isArray(a.parts) ? a.parts : []))
    .filter((p) => p && typeof p.text === 'string')
    .map((p) => p.text).join('\n');
  return {
    answer,
    runId: task?.metadata?.['agentmesh/run_id'] ?? null,
    state: task?.status?.state ?? null,
    errorCode: task?.metadata?.['agentmesh/error_code'] ?? null,
    task
  };
}

/** Final (state:'done') delegate records for one agent, sorted by started_at. */
export async function readRuns(agent) {
  let files = [];
  try { files = await readdir(agent.logDir); } catch { return []; }
  const recs = [];
  for (const f of files.filter((n) => n.startsWith('delegate-') && n.endsWith('.jsonl')).sort()) {
    recs.push(...await readRunLogRecords(join(agent.logDir, f)));
  }
  return dedupeRunRecords(recs)
    .filter((r) => r.state === 'done')
    .sort((x, y) => { const a = String(x.started_at ?? ''), b = String(y.started_at ?? ''); return a < b ? -1 : a > b ? 1 : 0; });
}

export async function gitClean(agent) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: agent.root });
  // Two bookkeeping dirs are EXPECTED residue, not task output:
  //  - `.claude/`     — the claude CLI's own state dir in its cwd (same rule
  //    as test/demo-e2e.test.js: agent folders ARE Claude projects);
  //  - `.agent-mesh/` — the framework's state dir (run logs by default, and
  //    the per-caller epoch file that a durable `new_conversation` reset
  //    persists — spec §3.4; scenario 06 legitimately produces this).
  // Anything else counts as dirty.
  const IGNORED = ['.claude', '.agent-mesh'];
  const dirty = stdout.split('\n').filter(Boolean).filter((l) => {
    const path = l.slice(3);
    return !IGNORED.some((d) => path === d || path === `${d}/` || path.startsWith(`${d}/`));
  });
  return dirty.length === 0;
}

/** Remove the temp mesh + logs + the real-claude transcript dirs it created. */
export async function cleanupMesh(mesh) {
  for (const a of Object.values(mesh.agents)) {
    try {
      const enc = encodeProjectDir(await realpath(a.root));
      await rm(join(homedir(), '.claude', 'projects', enc), RM_OPTS);
    } catch { /* best-effort */ }
  }
  await rm(mesh.meshRoot, RM_OPTS);
  await rm(mesh.logsBase, RM_OPTS);
}
