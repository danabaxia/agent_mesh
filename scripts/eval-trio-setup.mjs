#!/usr/bin/env node
// Materialize the eval TRIO (app driver + lib peer + docs middle-hop) into a
// disposable workspace, wired with the framework's OWN canonical commands. The
// trio covers the two scenarios a pair cannot:
//
//   peer-selection : app peers [lib, docs] → must route to the right one.
//   two-hop-chain  : app → docs → lib (docs onward-delegates for the shelf code).
//
// Flow:
//   init-mesh → add app/lib/docs (modes ask,do)
//   patch mesh.json: app.peers=['lib','docs'], docs.peers=['lib']
//   doctor --apply → generate registry.json + sync peer-bridge .mcp.json for
//                    both app and docs.
//
// Transport stays STDIO A2A (serve-a2a) + the agentmesh_peerbridge stdio MCP
// server. This script never spawns `claude`.
//
//   node scripts/eval-trio-setup.mjs [target-dir] [--force]

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const bin = join(repoRoot, 'bin', 'agent-mesh.js');
const srcTrio = join(repoRoot, 'examples', 'eval-trio');

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
  ws = mkdtempSync(join(tmpdir(), 'agent-mesh-eval-trio-'));
}
ws = realpathSync(ws);

const mesh = (cmdArgs) => execFileSync(process.execPath, [bin, ...cmdArgs], { cwd: ws, stdio: 'pipe' });

// 1. Substrate + the three agents from the source templates.
mesh(['init-mesh', ws]);
for (const name of ['app', 'lib', 'docs']) {
  mesh(['add', ws, join(srcTrio, name), '--name', name, '--modes', 'ask,do', '--apply']);
}

// 2. Peering (add leaves peers:[]): app routes to both; docs onward-routes to lib.
const meshJsonPath = join(ws, 'mesh.json');
const manifest = JSON.parse(readFileSync(meshJsonPath, 'utf8'));
const byName = (n) => manifest.agents.find((a) => a.name === n);
byName('app').peers = ['lib', 'docs'];
byName('docs').peers = ['lib'];
writeFileSync(meshJsonPath, JSON.stringify(manifest, null, 2) + '\n');

// 3. Framework generates registry.json + peer-bridge .mcp.json for app and docs.
mesh(['doctor', ws, '--apply']);

// 4. Each agent is its own git root (canonical files_changed / clean baseline).
let gitNote = '';
for (const name of ['app', 'lib', 'docs']) {
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
process.stdout.write(
  `\nEval trio ready (stdio A2A, doctor-wired):\n` +
  `  mesh:         ${ws}\n` +
  `  app (driver):  ${appRoot}   peers: lib, docs\n` +
  `  lib (peer):    ${join(ws, 'lib')}\n` +
  `  docs (hop):    ${join(ws, 'docs')}   peers: lib\n` +
  gitNote +
  `\nDrive the app with real claude (full map in examples/eval-trio/README.md):\n\n` +
  `  cd ${appRoot}\n\n` +
  `  # peer-selection: a catalog question must route to lib, not docs\n` +
  `  claude -p "What is the shelf code for The Dune Atlas? Reply with the exact code."\n\n` +
  `  # two-hop chain: app -> docs -> lib\n` +
  `  claude -p "Ask the docs agent to draft a release note for The Dune Atlas that includes its canonical shelf code."\n`
);
