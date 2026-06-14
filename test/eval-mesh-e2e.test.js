// Opt-in real-`claude` end-to-end test for the eval TRIO (examples/eval-trio):
// a real Claude Code driving the `app` agent must (1) select the correct peer
// for a request and (2) drive a two-hop onward-delegation chain — over the live
// stdio A2A peer-bridge, never a stub.
//
// SKIPPED by default so `npm test` stays hermetic. Enable:
//
//   AGENT_MESH_E2E=1 npm test
//
// Requires `claude` on PATH. Complementary to test/demo-e2e.test.js (which
// covers the MCP-compat do-mode write path); this file covers the A2A
// peer-bridge routing + onward-delegation path the pair/trio fixtures exist for.
//
// PLATFORM: POSIX-only (macOS/Linux), same as demo-e2e.test.js — `claude` is
// driven with execFileSync, which cannot resolve the Windows `.cmd` shim, so on
// win32 every test here skips even when claude is installed (expected, not a
// failure). The Windows live check remains `node scripts/live-a2a-check.mjs`.
//
// The peer-bridge is ASK-ONLY in v1, so both scenarios are ask-mode (no writes).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Materialize a fresh, doctor-wired trio workspace; return its agent roots.
function setupTrio() {
  const ws = mkdtempSync(join(tmpdir(), 'agent-mesh-trio-e2e-'));
  execFileSync('node', [join(repoRoot, 'scripts', 'eval-trio-setup.mjs'), ws, '--force'], { stdio: 'pipe' });
  return { ws, app: join(ws, 'app'), lib: join(ws, 'lib'), docs: join(ws, 'docs') };
}

// True iff an agent root recorded at least one completed delegate run (i.e. it
// was actually spawned and did work as a peer).
function agentRan(root) {
  const logsDir = join(root, '.agent-mesh', 'logs');
  if (!existsSync(logsDir)) return false;
  return readdirSync(logsDir).some((f) => f.startsWith('delegate-') && f.endsWith('.jsonl'));
}

// Drive the `app` agent headlessly through its doctor-wired peer-bridge.
function driveApp(appRoot, prompt) {
  const out = execFileSync(
    'claude',
    [
      '-p', prompt,
      '--strict-mcp-config',
      '--mcp-config', join(appRoot, '.mcp.json'),
      '--allowedTools',
      'mcp__agentmesh_peerbridge__delegate_to_peer,mcp__agentmesh_peerbridge__list_peers,Read',
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json'
    ],
    { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

test('real claude: peer-selection — a catalog question routes to lib, not docs', { skip, timeout: 600_000 }, () => {
  const { app, lib, docs } = setupTrio();
  const report = driveApp(
    app,
    'What is the canonical shelf code for the book "The Dune Atlas"? ' +
      'Use a peer if you need to, and reply with the exact code.'
  );
  assert.equal(report.is_error, false, 'claude run should not error');
  assert.match(report.result, /DUNE-7F/, 'the answer must carry the lib-owned shelf code');

  // Selection property: the library peer actually ran; the docs peer did not.
  assert.ok(agentRan(lib), 'lib (the correct peer) must have run');
  assert.ok(!agentRan(docs), 'docs (the wrong peer) must not have been delegated to');
});

test('real claude: two-hop chain — app → docs → lib for the shelf code', { skip, timeout: 600_000 }, () => {
  const { app, lib, docs } = setupTrio();
  const report = driveApp(
    app,
    'Ask the docs agent to draft a one-line release note for the book ' +
      '"The Dune Atlas" that includes its canonical shelf code, then relay the note.'
  );
  assert.equal(report.is_error, false, 'claude run should not error');
  assert.match(report.result, /DUNE-7F/, 'the relayed note must carry the shelf code sourced two hops away');

  // Both hops happened: docs (hop 1) ran, and docs onward-delegated to lib (hop 2).
  assert.ok(agentRan(docs), 'docs (first hop) must have run');
  assert.ok(agentRan(lib), 'lib (second, onward hop) must have run');

  // The two-hop happy path is confined: no path-guard denials anywhere.
  for (const root of [app, docs, lib]) {
    assert.ok(
      !existsSync(join(root, '.agent-mesh', 'logs', 'path-guard-denials.jsonl')),
      `confined ask-only chain must record no path-guard denials (${root})`
    );
  }
});
