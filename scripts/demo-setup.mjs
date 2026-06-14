#!/usr/bin/env node
// Materialize the App→Library demo into a fresh, disposable workspace so the
// real `claude` can run it with canonical git identity for folder B.
//
//   node scripts/demo-setup.mjs [target-dir] [--force]
//
// Prints the workspace path and the exact `claude` command to run. Never
// spawns `claude` itself.

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const bin = join(repoRoot, 'bin', 'agent-mesh.js');
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
  ws = mkdtempSync(join(tmpdir(), 'agent-mesh-demo-'));
}
ws = realpathSync(ws);

const agentA = join(ws, 'agent-a');
const agentB = join(ws, 'agent-b');
cpSync(join(repoRoot, 'examples', 'agent-a'), agentA, { recursive: true });
cpSync(join(repoRoot, 'examples', 'agent-b'), agentB, { recursive: true });

// Folder B is its own git root so files_changed / preexisting_dirty are
// canonical; one initial commit => clean tree => preexisting_dirty:false.
let gitNote = '';
try {
  const git = (a) => execFileSync('git', a, { cwd: agentB, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'demo@example.com']);
  git(['config', 'user.name', 'demo']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed library fixture']);
} catch {
  gitNote = '  (git unavailable: files_changed will be null for the library)\n';
}

// Render agent-a/.mcp.json from the template with this machine's real paths.
const template = readFileSync(join(agentA, '.mcp.json.template'), 'utf8');
writeFileSync(
  join(agentA, '.mcp.json'),
  template.replaceAll('__AGENT_MESH_BIN__', bin).replaceAll('__AGENT_B_ROOT__', agentB)
);
rmSync(join(agentA, '.mcp.json.template'));

process.stdout.write(
  `\nDemo workspace ready:\n` +
  `  app (A):     ${agentA}\n` +
  `  library (B): ${agentB}\n` +
  gitNote +
  `\nRun the demo (real claude, A delegates a real code change to B):\n\n` +
  `  cd ${agentA}\n` +
  `  claude -p "Use the library peer to add a truncateSlug(str, max) helper ` +
  `to its strings lib, then report what changed."\n\n` +
  `Then inspect ${join(agentB, 'lib', 'strings.js')} and ` +
  `${join(agentB, '.agent-mesh', 'logs')}.\n`
);
