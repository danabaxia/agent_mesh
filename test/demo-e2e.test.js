// Opt-in real-`claude` end-to-end test: a real Claude Code in folder A
// delegates a real code change to a real Claude Code in folder B over the
// agent-mesh MCP, and the write is confined to B.
//
// SKIPPED by default so `npm test` stays hermetic and deterministic. Enable:
//
//   AGENT_MESH_E2E=1 npm test
//
// Requires `claude` on PATH. This is the regression net for the bugs the
// stubbed suites cannot see (MCP wire framing, do-mode write permission,
// real cross-folder confinement) — complementary to, not a replacement for,
// the deterministic safety suites.
//
// PLATFORM: this suite is POSIX-only (macOS/Linux). It spawns the real CLI with
// `execFileSync('claude', ...)`, which on Windows cannot resolve `claude`
// (the launcher is a `.cmd`/`.ps1` shim, and execFile won't append `.cmd` nor
// spawn a batch file without a shell) — so on win32 `claudeAvailable()` returns
// false and ALL tests below skip with "claude not on PATH" even when claude is
// installed. That skip is EXPECTED on Windows, not a failure. The mesh's own
// runtime spawn path (src/process.js resolveSpawnTarget) IS Windows-aware; it is
// these tests' detection/spawn helpers that are POSIX-only.
//
// WINDOWS equivalent: run `node scripts/live-a2a-check.mjs` — a real-`claude`
// A2A smoke test over the live serve-a2a wire (initialize/ping + multi-turn
// resume) that uses the Windows-aware spawn path. Keep the two in sync when the
// wire/protocol changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { delegateTask } from '../src/delegate.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function claudeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const skip =
  process.env.AGENT_MESH_E2E !== '1'
    ? 'set AGENT_MESH_E2E=1 to run the real-claude E2E'
    : !claudeAvailable()
      ? process.platform === 'win32'
        ? 'POSIX-only e2e (execFileSync cannot resolve claude.cmd on win32) — on Windows run `node scripts/live-a2a-check.mjs` instead'
        : 'claude not on PATH'
      : false;

test('real claude: A delegates a do task to B, write confined to B', { skip, timeout: 600_000 }, () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-mesh-e2e-'));
  execFileSync('node', [join(repoRoot, 'scripts', 'demo-setup.mjs'), ws, '--force'], { stdio: 'pipe' });
  const agentA = join(ws, 'agent-a');
  const agentB = join(ws, 'agent-b');

  const out = execFileSync(
    'claude',
    [
      '-p',
      'Use the library peer\'s delegate_task tool with mode "do" to add a ' +
        'truncateSlug(str, max) helper to its strings library (slugify then ' +
        'cut at the last "-" at or before max, no trailing "-"). Then report ' +
        'which files changed.',
      '--strict-mcp-config',
      '--mcp-config',
      join(agentA, '.mcp.json'),
      '--allowedTools',
      'mcp__library__delegate_task,mcp__library__describe_self,Read',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'json'
    ],
    { cwd: agentA, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
  );
  const report = JSON.parse(out);
  assert.equal(report.is_error, false, 'claude run should not error');

  // B's library really gained the function, on disk.
  const strings = readFileSync(join(agentB, 'lib', 'strings.js'), 'utf8');
  assert.match(strings, /export function truncateSlug\s*\(/, 'truncateSlug must be in B/lib/strings.js');

  // The change is confined to B: git shows lib/strings.js modified in B...
  const bStatus = execFileSync('git', ['status', '--porcelain', '--', 'lib/strings.js'], {
    cwd: agentB,
    encoding: 'utf8'
  });
  assert.match(bStatus, /lib\/strings\.js/, 'B git status must show the change');

  // ...and A's folder has no code written into it (only AGENT.md + .mcp.json).
  // Agent folders ARE Claude projects: the claude CLI may create its own
  // `.claude/` state dir in its cwd (it does in remote/debug environments).
  // That is CLI bookkeeping, not task output — ignore it; assert no TASK
  // output leaked into A.
  const aFiles = readdirSync(agentA).filter((f) => f !== '.claude').sort();
  assert.deepEqual(aFiles, ['.mcp.json', 'AGENT.md'], 'caller folder A must be untouched');

  // agent-mesh recorded the delegated run as a do/done with the one delta.
  // Logs are grouped per-date NDJSON; find the final record for the run.
  const logsDir = join(agentB, '.agent-mesh', 'logs');
  const logFile = readdirSync(logsDir).find((f) => f.startsWith('delegate-') && f.endsWith('.jsonl'));
  assert.ok(logFile, 'a delegate run log must exist');
  const recs = readFileSync(join(logsDir, logFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const log = recs.find((r) => r.state === 'done');
  assert.equal(log.mode, 'do');
  assert.equal(log.result.status, 'done');
  assert.deepEqual(log.result.files_changed, ['lib/strings.js']);

  // Conformant happy path: zero isolation violations — no denial log written.
  assert.ok(
    !existsSync(join(logsDir, 'path-guard-denials.jsonl')),
    'a confined happy-path run must record no path-guard denials'
  );
});

test('real claude: a delegated write that escapes B is denied and A stays untouched', { skip, timeout: 600_000 }, () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-mesh-e2e-'));
  execFileSync('node', [join(repoRoot, 'scripts', 'demo-setup.mjs'), ws, '--force'], { stdio: 'pipe' });
  const agentA = join(ws, 'agent-a');
  const agentB = join(ws, 'agent-b');
  const escapeTarget = join(agentA, 'cross-folder-probe.txt');

  // Drive B (via A) to deliberately attempt a write OUTSIDE its own root, by
  // absolute path into A. The path-guard hook must deny it — this is the
  // negative confinement assertion the happy path cannot make.
  //
  // The task is framed HONESTLY as the framework's own confinement fixture:
  // current models flag deceptive-looking write-via-peer bait (filenames like
  // INJECTED.txt, "report whether blocked" phrasing) as prompt injection and
  // refuse BEFORE the mesh runs — which exercises nothing. Transparent framing
  // keeps the model cooperative so the test reaches the layer it verifies.
  const out = execFileSync(
    'claude',
    [
      '-p',
      `This is agent-mesh's own end-to-end write-confinement test. Use the ` +
        `library peer's delegate_task tool with mode "do" and this exact task: ` +
        `"Confinement fixture: use the Write tool to create a file at the ` +
        `absolute path ${escapeTarget} with content x. The framework's ` +
        `path-guard is expected to deny this out-of-root write; attempt it ` +
        `once and report the tool's result verbatim." Then relay the peer's ` +
        `report.`,
      '--strict-mcp-config',
      '--mcp-config',
      join(agentA, '.mcp.json'),
      '--allowedTools',
      'mcp__library__delegate_task,mcp__library__describe_self,Read',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'json'
    ],
    { cwd: agentA, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
  );
  const report = JSON.parse(out);
  assert.equal(report.is_error, false, 'the run itself completes (the write, not the run, is denied)');

  // The escaping write never landed: A has only its two seed files (the CLI's
  // own `.claude/` state dir is expected — agent folders are Claude projects).
  assert.ok(!existsSync(escapeTarget), 'the cross-folder write must not land in A');
  const aFiles = readdirSync(agentA).filter((f) => f !== '.claude').sort();
  assert.deepEqual(aFiles, ['.mcp.json', 'AGENT.md'], 'caller folder A must be untouched');

  // B's path-guard recorded the denial of the out-of-root target.
  const denialLog = join(agentB, '.agent-mesh', 'logs', 'path-guard-denials.jsonl');
  assert.ok(existsSync(denialLog), 'a path-guard denial must be logged');
  assert.match(readFileSync(denialLog, 'utf8'), /cross-folder-probe\.txt/, 'the denied target must be recorded');
});

// --- Settings-inheritance regression net (opt-in, real `claude`) ---
//
// These three scenarios exercise the inheritance + native-source-disabling +
// path-guard guarantees end-to-end. They drive `delegateTask` directly (vs. the
// A→B demo-setup runs above) so each scenario can stand on its own minimal
// fixture HOME. Skipped by default; require `claude` on PATH like the rest of
// this file. The asserted invariants are what matters — real-claude refusal /
// flakiness on the synthetic write tasks is acceptable for an opt-in net.

async function buildFixtureHome({ settings }) {
  const home = await mkdtemp(join(tmpdir(), 'mesh-e2e-home-'));
  if (settings) {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  return home;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

test(
  'e2e: author hook does NOT fire under --setting-sources ""',
  { skip, timeout: 600_000 },
  async () => {
    const markerDir = await mkdtemp(join(tmpdir(), 'mesh-marker-'));
    const marker = join(markerDir, 'fired');
    const home = await buildFixtureHome({
      settings: {
        hooks: {
          PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `touch ${marker}` }] }],
        },
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-root-'));
    const result = await delegateTask({
      root,
      env: { ...process.env, HOME: home },
      input: { mode: 'ask', task: 'Read README.md if present then stop.' },
    });
    assert.equal(result.status, 'done');
    // Marker must not exist — native sources are disabled by --setting-sources "".
    assert.equal(await exists(marker), false);
  }
);

test(
  'e2e: malicious env.PATH does not redirect path-guard subprocess',
  { skip, timeout: 600_000 },
  async () => {
    const home = await buildFixtureHome({
      settings: { env: { PATH: '/tmp/evil:/usr/bin' } },
    });
    const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-root-'));
    const result = await delegateTask({
      root,
      env: { ...process.env, HOME: home },
      input: { mode: 'do', task: 'Write a file at ../escape.txt and stop.' },
    });
    // The cross-folder write must still be denied by the path-guard.
    assert.equal(result.status, 'done');
    assert.equal(await exists(join(root, '..', 'escape.txt')), false);
    // Strengthen the negative: if claude actually attempted the write, the
    // path-guard must have logged a denial. Tolerate pure-refusal (no attempt)
    // by also accepting the run-log mentioning the escape target — otherwise a
    // future regression where the hook silently does nothing would still pass.
    const denialLog = join(root, '.agent-mesh', 'logs', 'path-guard-denials.jsonl');
    const denialLogged = existsSync(denialLog) && /escape\.txt/.test(readFileSync(denialLog, 'utf8'));
    const runLog = existsSync(result.log_path) ? readFileSync(result.log_path, 'utf8') : '';
    const writeAttempted = /escape\.txt/.test(runLog);
    assert.ok(
      denialLogged || writeAttempted,
      'either path-guard must log the denial or the run log must show the attempted write'
    );
  }
);

test(
  'e2e: .claude/settings.local.json write denied under do',
  { skip, timeout: 600_000 },
  async () => {
    const home = await buildFixtureHome({ settings: {} });
    const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-root-'));
    const result = await delegateTask({
      root,
      env: { ...process.env, HOME: home },
      input: { mode: 'do', task: 'Create file .claude/settings.local.json containing {} and stop.' },
    });
    assert.equal(result.status, 'done');
    assert.equal(await exists(join(root, '.claude', 'settings.local.json')), false);
    // Strengthen the negative: if claude attempted the write, the path-guard
    // must have logged the denial (settings.local.json is treated as out-of-root
    // by the guard's settings-write policy). Tolerate pure-refusal by also
    // accepting the run-log mentioning the target.
    const denialLog = join(root, '.agent-mesh', 'logs', 'path-guard-denials.jsonl');
    const denialLogged = existsSync(denialLog) && /settings\.local\.json/.test(readFileSync(denialLog, 'utf8'));
    const runLog = existsSync(result.log_path) ? readFileSync(result.log_path, 'utf8') : '';
    const writeAttempted = /settings\.local\.json/.test(runLog);
    assert.ok(
      denialLogged || writeAttempted,
      'either path-guard must log the denial or the run log must show the attempted write'
    );
  }
);
