#!/usr/bin/env node
// Materialize the eval pair (app driver + lib peer) into a disposable workspace,
// wired with the framework's OWN canonical commands so the wiring is real, not
// hand-rolled:
//
//   init-mesh  → mesh substrate
//   add app    → copy + manifest entry (modes ask,do)
//   add lib    → copy + manifest entry (modes ask,do)
//   (patch mesh.json: app.peers = ['lib'])
//   doctor --apply → generate app/registry.json + sync the peer-bridge .mcp.json
//
// The agent↔agent transport stays STDIO A2A: registry.json points at
// `agent-mesh serve-a2a <peer>` and doctor wires the `agentmesh_peerbridge`
// stdio MCP server into app/.mcp.json. This script never spawns `claude`.
//
//   node scripts/eval-pair-setup.mjs [target-dir] [--force]
//
// Prints the workspace paths and the exact commands that exercise each eval
// behavior (see examples/eval-pair/README.md for the full map).

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const bin = join(repoRoot, 'bin', 'agent-mesh.js');
const srcPair = join(repoRoot, 'examples', 'eval-pair');

const args = process.argv.slice(2);
const force = args.includes('--force');
const targetArg = args.find((a) => a !== '--force');

let ws;
if (targetArg) {
  ws = targetArg;
  if (existsSync(ws) && readdirSync(ws).length > 0 && !force) {
    console.error(`Refusing to use non-empty ${ws} (pass --force to override).`);
    process.exit(1);
  }
  mkdirSync(ws, { recursive: true });
} else {
  ws = mkdtempSync(join(tmpdir(), 'agent-mesh-eval-pair-'));
}
ws = realpathSync(ws);

const mesh = (cmdArgs) => execFileSync(process.execPath, [bin, ...cmdArgs], { cwd: ws, stdio: 'pipe' });

// 1. Mesh substrate, then add both agents from the source templates.
mesh(['init-mesh', ws]);
mesh(['add', ws, join(srcPair, 'app'), '--name', 'app', '--modes', 'ask,do', '--apply']);
mesh(['add', ws, join(srcPair, 'lib'), '--name', 'lib', '--modes', 'ask,do', '--apply']);

// 2. Peer the driver to the library (add leaves peers:[]; this is the one edit).
const meshJsonPath = join(ws, 'mesh.json');
const manifest = JSON.parse(readFileSync(meshJsonPath, 'utf8'));
const appEntry = manifest.agents.find((a) => a.name === 'app');
appEntry.peers = ['lib'];
writeFileSync(meshJsonPath, JSON.stringify(manifest, null, 2) + '\n');

// 3. Let the framework generate registry.json + the peer-bridge .mcp.json wiring.
mesh(['doctor', ws, '--apply']);

// 4. Each agent is its own git root so files_changed / preexisting_dirty are
//    canonical (one seed commit => clean tree).
let gitNote = '';
for (const name of ['app', 'lib']) {
  const root = join(ws, name);
  try {
    const git = (a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'eval@example.com']);
    git(['config', 'user.name', 'eval']);
    git(['add', '-A']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `seed ${name} fixture`]);
  } catch {
    gitNote = '  (git unavailable: files_changed will be null)\n';
  }
}

const appRoot = join(ws, 'app');
const libRoot = join(ws, 'lib');
process.stdout.write(
  `\nEval pair ready (stdio A2A, doctor-wired):\n` +
  `  mesh:        ${ws}\n` +
  `  app (driver): ${appRoot}\n` +
  `  lib (peer):   ${libRoot}\n` +
  gitNote +
  `\nDrive the app with real claude — examples (full map in examples/eval-pair/README.md):\n\n` +
  `  cd ${appRoot}\n\n` +
  `  # should-delegate: only lib knows the shelf code\n` +
  `  claude -p "What is the shelf code for the book The Dune Atlas? Reply with the exact code."\n\n` +
  `  # should-NOT-delegate: a trivial self-question\n` +
  `  claude -p "In one sentence, what does this app do?"\n\n` +
  `  # do-write-lands: ask the library to add a helper in its own folder\n` +
  `  claude -p "Use the library peer to add a truncateSlug(str, max) helper to its strings lib, then report what changed."\n\n` +
  `Then inspect ${join(libRoot, 'lib', 'strings.js')} and ${join(libRoot, '.agent-mesh', 'logs')}.\n`
);
