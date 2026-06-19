import { realpath } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
// Command modules are imported LAZILY inside each command branch: the bin is
// spawned per peer/bridge on EVERY delegation, and the full static graph cost
// ~95ms vs ~40ms for what serve-peer-bridge actually needs. Faster entrypoints
// also shrink the claude-CLI MCP startup race (servers report "pending" at the
// init event; the first model call may otherwise begin before tools register).

function usage() {
  return [
    'Usage:',
    '  agent-mesh serve <folder>',
    '  agent-mesh serve-a2a <folder>',
    '  agent-mesh init-mesh <folder>',
    '  agent-mesh add <mesh-root> <agent-folder> [--name X] [--modes ask,do] [--role "..."] [--apply] [--force]',
    '  agent-mesh join <mesh-root> <name-or-folder>',
    '  agent-mesh leave <mesh-root> <name>',
    '  agent-mesh validate <mesh-root> [agent]',
    '  agent-mesh doctor <mesh-root> [agent] [--apply]',
    '  agent-mesh dashboard <mesh-root> [--port 7077] [--no-open] [--allow-shell] [--enable-chat] [--no-replace]',
    '  agent-mesh shell <mesh-root> <agent>   # open native claude in an agent folder',
    '',
    '  agent-mesh dev-society status [--repo OWNER/REPO]      # daemon + ledger + queue snapshot',
    '  agent-mesh dev-society ledger [--last N]               # pretty-print ledger.jsonl',
    '  agent-mesh issue label <num> [--add L]... [--remove L]... [--repo OWNER/REPO]',
    '',
    'Environment:',
    '  AGENT_MESH_DEPTH=3',
    '  AGENT_MESH_TIMEOUT_MS=600000',
    '  AGENT_MESH_CLAUDE=claude',
    '  AGENT_MESH_LOG_DIR=.agent-mesh/logs',
    '  AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1   (Windows only; deployment-owner attestation that managed-settings policy is compatible with the mesh path-guard)'
  ].join('\n');
}

export async function main(argv, env = process.env) {
  const [command, folder] = argv;

  if (command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'init-mesh') {
    if (!folder) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    // resolve to absolute (folder may not exist yet, so we can't realpath it)
    const meshRoot = resolve(folder);
    try {
      const { initMesh } = await import('./builder/init-mesh.js');
      const created = await initMesh(meshRoot);
      process.stdout.write('Initialized mesh substrate:\n');
      for (const p of created) {
        process.stdout.write(`  ${p}\n`);
      }
      process.stdout.write('\nNext steps:\n');
      process.stdout.write('  1. Add agents:   agent-mesh add . <agent-folder>\n');
      process.stdout.write('  2. View manifest: cat mesh.json\n');
      process.stdout.write('  3. Dashboard:     agent-mesh dashboard .\n');
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'add') {
    const [meshRootArg, agentFolderArg, ...rest] = argv.slice(1);
    if (!meshRootArg || !agentFolderArg) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const meshRoot = resolve(meshRootArg);
    const agentFolder = resolve(agentFolderArg);

    // Parse flags
    let name;
    let modes = ['ask'];
    let role;
    let applyFlag = false;
    let forceFlag = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--apply') { applyFlag = true; continue; }
      if (arg === '--force') { forceFlag = true; continue; }
      if (arg === '--name' && rest[i + 1]) { name = rest[++i]; continue; }
      if (arg.startsWith('--name=')) { name = arg.slice('--name='.length); continue; }
      if (arg === '--modes' && rest[i + 1]) { modes = rest[++i].split(',').map(m => m.trim()); continue; }
      if (arg.startsWith('--modes=')) { modes = arg.slice('--modes='.length).split(',').map(m => m.trim()); continue; }
      if (arg === '--role' && rest[i + 1]) { role = rest[++i]; continue; }
      if (arg.startsWith('--role=')) { role = arg.slice('--role='.length); continue; }
    }

    try {
      const { add } = await import('./builder/add.js');
      const result = await add(meshRoot, agentFolder, { name, modes, role, apply: applyFlag, force: forceFlag });
      if (result.dryRun) {
        process.stdout.write('[dry-run] No files written. Pass --apply to execute.\n\n');
        process.stdout.write(`Agent name:  ${result.manifestEntry.name}\n`);
        process.stdout.write(`Destination: ${result.dest}\n`);
        process.stdout.write(`Modes:       ${result.manifestEntry.enabledModes.join(', ')}\n`);
        if (result.scaffold.length > 0) {
          process.stdout.write('\nFiles to scaffold (missing anatomy):\n');
          for (const { path } of result.scaffold) {
            process.stdout.write(`  ${path}\n`);
          }
        } else {
          process.stdout.write('\nNo scaffold gaps detected.\n');
        }
      } else {
        process.stdout.write(`Added agent "${result.manifestEntry.name}" to mesh.\n`);
        process.stdout.write(`  Destination: ${result.dest}\n`);
        if (result.createdFiles.length > 0) {
          process.stdout.write(`  Scaffolded:\n`);
          for (const p of result.createdFiles) {
            process.stdout.write(`    ${p}\n`);
          }
        }
        if (result.skipped.length > 0) {
          process.stdout.write(`  Skipped (${result.skipped.length} items — secrets/build dirs/etc.)\n`);
        }
        process.stdout.write(`  Registry files written: ${result.registryFiles.length}\n`);
      }
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'join') {
    const [meshRootArg, nameOrFolderArg, ...rest] = argv.slice(1);
    if (!meshRootArg || !nameOrFolderArg) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const meshRoot = resolve(meshRootArg);
    // resolve the nameOrFolder arg: if it looks like a path, resolve it; otherwise treat as name
    const nameOrFolder = nameOrFolderArg.startsWith('/') || nameOrFolderArg.startsWith('.')
      ? resolve(nameOrFolderArg)
      : nameOrFolderArg;

    // Parse optional --modes
    let modes = ['ask'];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--modes' && rest[i + 1]) { modes = rest[++i].split(',').map(m => m.trim()); continue; }
      if (arg.startsWith('--modes=')) { modes = arg.slice('--modes='.length).split(',').map(m => m.trim()); continue; }
    }

    try {
      const { join: joinMesh } = await import('./builder/join.js');
      const result = await joinMesh(meshRoot, nameOrFolder, { modes });
      process.stdout.write(`Joined agent "${result.name}" into mesh.\n`);
      if (result.registriesRegenerated.length > 0) {
        process.stdout.write(`  Registries regenerated: ${result.registriesRegenerated.length}\n`);
      }
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          process.stdout.write(`  warning: ${w}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'leave') {
    const [meshRootArg, nameArg] = argv.slice(1);
    if (!meshRootArg || !nameArg) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const meshRoot = resolve(meshRootArg);
    const name = nameArg;

    try {
      const { leave } = await import('./builder/leave.js');
      const result = await leave(meshRoot, name);
      process.stdout.write(`Agent "${name}" has left the mesh.\n`);
      if (result.prunedFrom.length > 0) {
        process.stdout.write(`  Pruned from peers of: ${result.prunedFrom.join(', ')}\n`);
      }
      if (result.registriesRegenerated.length > 0) {
        process.stdout.write(`  Registries regenerated: ${result.registriesRegenerated.length}\n`);
      }
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          process.stdout.write(`  warning: ${w}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'validate') {
    const [meshRootArg, agentArg] = argv.slice(1);
    if (!meshRootArg) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const meshRoot = resolve(meshRootArg);
    const opts = agentArg ? { agentName: agentArg } : {};

    try {
      const { loadSnapshot, checkConformance } = await import('./builder/conformance.js');
      const snapshot = await loadSnapshot(meshRoot, opts);

      // If no manifest could be loaded, treat it as a fatal conformance failure
      if (snapshot.manifestError) {
        process.stderr.write(`error: could not read mesh.json: ${snapshot.manifestError}\n`);
        process.exitCode = 1;
        return;
      }

      const report = checkConformance(snapshot);

      // Print rule report
      for (const r of report.rules) {
        const icon = r.level === 'pass' ? '✓' : r.level === 'warn' ? '⚠' : '✗';
        process.stdout.write(`${icon} [${r.level.toUpperCase()}] ${r.rule}: ${r.detail}\n`);
      }
      process.stdout.write('\n');
      if (report.ok) {
        process.stdout.write('Conformance: OK\n');
      } else {
        process.stdout.write('Conformance: FAIL\n');
        process.exitCode = 1;
      }
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'doctor') {
    const [meshRootArg, ...rest] = argv.slice(1);
    if (!meshRootArg) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const meshRoot = resolve(meshRootArg);

    // Parse optional agent name and --apply flag
    let agentName;
    let applyFlag = false;
    for (const arg of rest) {
      if (arg === '--apply') { applyFlag = true; continue; }
      if (!arg.startsWith('--') && !agentName) { agentName = arg; }
    }

    try {
      const { doctor } = await import('./builder/doctor.js');
      const result = await doctor(meshRoot, { agentName, apply: applyFlag });

      if (!applyFlag) {
        process.stdout.write('[dry-run] Pass --apply to execute fixes.\n\n');
      }

      if (result.fixed.length > 0) {
        process.stdout.write('Fixed (auto):\n');
        for (const f of result.fixed) process.stdout.write(`  ${f}\n`);
      }
      if (result.seeded.length > 0) {
        process.stdout.write('Seeded (new files):\n');
        for (const s of result.seeded) process.stdout.write(`  ${s}\n`);
      }
      if (result.proposed.length > 0) {
        process.stdout.write('Proposed patches (*.proposed — review and apply manually):\n');
        for (const p of result.proposed) process.stdout.write(`  ${p}\n`);
      }
      if (result.flagged.length > 0) {
        process.stdout.write('Flagged (manual action required):\n');
        for (const f of result.flagged) process.stdout.write(`  ${f}\n`);
      }
      if (
        result.fixed.length === 0 &&
        result.seeded.length === 0 &&
        result.proposed.length === 0 &&
        result.flagged.length === 0
      ) {
        process.stdout.write('Nothing to fix — mesh is conformant.\n');
      }
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'dashboard') {
    const [meshRootArg, ...rest] = argv.slice(1);
    if (!meshRootArg) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const meshRoot = resolve(meshRootArg);

    let port = 7077;
    let noOpen = false;
    let allowShell = env.AGENT_MESH_DASHBOARD_SHELL === '1';
    // In-dashboard chat (ask-only A2A console) is OFF by default: the dashboard is
    // a read-only monitor and Claude is driven from the external CLI. Opt in with
    // --enable-chat (or AGENT_MESH_DASHBOARD_CHAT=1) to restore the chat composer.
    let chat = env.AGENT_MESH_DASHBOARD_CHAT === '1';
    let replace = true;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--no-open') { noOpen = true; continue; }
      if (arg === '--allow-shell') { allowShell = true; continue; }
      if (arg === '--enable-chat') { chat = true; continue; }
      if (arg === '--no-replace') { replace = false; continue; }
      if (arg === '--port' && rest[i + 1]) { port = parseInt(rest[++i], 10); continue; }
      if (arg.startsWith('--port=')) { port = parseInt(arg.slice('--port='.length), 10); continue; }
    }

    // Import single-instance helpers above the try so both the try and catch
    // blocks can call removePidfile (the catch runs in a different scope from
    // where we'd normally destructure inside the try).
    const { pidfilePath, reapExisting, writePidfile, removePidfile } = await import('./dashboard/single-instance.js');
    let pidfile = null;

    try {
      const { createDashboardServer } = await import('./dashboard/server.js');
      const srv = createDashboardServer({ meshRoot, port, allowShell, chat });
      if (allowShell) process.stdout.write('Native CLI launch: ENABLED (--allow-shell)\n');
      process.stdout.write(`In-dashboard chat: ${chat ? 'ENABLED (--enable-chat)' : 'disabled (read-only; drive Claude from the external CLI)'}\n`);
      pidfile = pidfilePath(port);
      await reapExisting({ pidfile, replace, log: (m) => process.stdout.write(m + '\n') });
      writePidfile(pidfile, { pid: process.pid, port, now: Date.now() });
      await srv.start();
      const bootstrapUrl = srv.bootstrapUrl;
      process.stdout.write(`Dashboard running at: ${srv.url}\n`);
      process.stdout.write(`Open (with token):    ${bootstrapUrl}\n`);

      if (!noOpen) {
        // Open the browser WITHOUT a shell. The old `exec('start "<url>"')` ran
        // through cmd.exe (exec is shell-by-default on win32, and `start` IS a
        // cmd.exe builtin) → a node.exe→cmd.exe lineage that CrowdStrike/EDR
        // flags. explorer.exe (win) / open (mac) / xdg-open (linux) open a URL
        // directly via spawn with an arg array — no shell, no cmd.exe.
        try {
          const { spawn } = await import('node:child_process');
          const opener = process.platform === 'win32' ? 'explorer.exe'
            : process.platform === 'darwin' ? 'open'
            : 'xdg-open';
          const ch = spawn(opener, [bootstrapUrl], { detached: true, stdio: 'ignore', windowsHide: true });
          ch.on('error', () => { /* no browser / headless — non-fatal */ });
          ch.unref();
        } catch { /* non-fatal */ }
      }

      // Keep running until SIGINT / SIGTERM
      await new Promise((resolve_) => {
        process.on('SIGINT', resolve_);
        process.on('SIGTERM', resolve_);
      });
      await srv.close();
      if (pidfile) removePidfile(pidfile);
    } catch (err) {
      const msg = err.code === 'EADDRINUSE'
        ? `port ${port} is already in use by another process (not a tracked dashboard); free it or use --port`
        : err.message;
      process.stderr.write(`error: ${msg}\n`);
      if (pidfile) removePidfile(pidfile);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'shell') {
    // Native CLI entry point from your own terminal: open interactive claude in
    // an agent folder, mesh-aware. Reuses the dashboard launcher.
    const [meshRootArg, agentName] = argv.slice(1);
    if (!meshRootArg || !agentName) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const meshRoot = await realpath(resolve(meshRootArg));
      const { readManifest } = await import('./builder/manifest.js');
      const { createShellLauncher } = await import('./dashboard/shell-launcher.js');
      const manifest = await readManifest(meshRoot);
      const entry = (manifest.agents || []).find((a) => a.name === agentName);
      if (!entry) { process.stderr.write(`error: no agent "${agentName}" in mesh.json\n`); process.exitCode = 1; return; }
      const agentRoot = await realpath(resolve(meshRoot, entry.root));
      const launcher = createShellLauncher({ meshRoot });
      const { planId, command, supported } = await launcher.buildPlan({ agentRoot, entry });
      process.stdout.write(`Command:\n  ${command}\n`);
      if (!supported) {
        process.stdout.write('\nThis platform has no terminal opener — copy the command above into your terminal.\n');
        return;
      }
      const result = await launcher.launch(planId);
      process.stdout.write(result.ok ? `\nOpened native Claude Code for "${agentName}".\n` : `\nCould not open a terminal (${result.reason}); copy the command above.\n`);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'session-exec') {
    // Hidden verb: the per-turn lease owner spawned by the dashboard session
    // runner. Not advertised in usage().
    const { runSessionExec } = await import('./dashboard/session-exec.js');
    await runSessionExec(argv.slice(1));
    return;
  }

  if (command === 'serve-mesh-health') {
    // Hidden verb: read-only mesh-health MCP server (the mesh-manager agent's
    // tool surface). Mesh root: explicit arg wins; else derived from the
    // framework env every served worker already carries.
    const explicit = argv[1];
    let meshRoot = null;
    try {
      if (explicit) meshRoot = await realpath(resolve(explicit));
      else if (env.AGENT_MESH_MESH_CEILING) meshRoot = env.AGENT_MESH_MESH_CEILING;
      else if (env.AGENT_MESH_MESH_ROOT) meshRoot = dirname(env.AGENT_MESH_MESH_ROOT);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (!meshRoot) {
      process.stderr.write('error: serve-mesh-health needs a mesh root (argument, or AGENT_MESH_MESH_CEILING / AGENT_MESH_MESH_ROOT in env)\n');
      process.exitCode = 2;
      return;
    }
    try {
      const { createMeshHealthServer } = await import('./mesh-health/server.js');
      const server = createMeshHealthServer({ meshRoot, env });
      await server.start(process.stdin, process.stdout);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase-1 unified ops surface (see src/dev-society-cli.js for rationale).
  // Lets sandbox-Claude AND host-human invoke the same verbs instead of round-
  // tripping through `gh` + cat ledger.jsonl + ls .dev-society/work/ shell paste.
  // ──────────────────────────────────────────────────────────────────────────
  if (command === 'dev-society') {
    const { runDevSocietyCli } = await import('./dev-society-cli.js');
    await runDevSocietyCli(argv.slice(1), env);
    return;
  }

  if (command === 'issue') {
    const { runIssueCli } = await import('./dev-society-cli.js');
    await runIssueCli(argv.slice(1), env);
    return;
  }

  if ((command !== 'serve' && command !== 'serve-a2a' && command !== 'serve-peer-bridge' && command !== 'serve-recall') || !folder) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const root = await realpath(folder);

  // Framework-owned peer bridge (hidden verb) — spawned by delegate.js as the
  // worker's onward-delegation MCP server. Not advertised in usage().
  if (command === 'serve-peer-bridge') {
    try {
      const { createPeerBridgeServer } = await import('./a2a/peer-bridge.js');
      const server = createPeerBridgeServer({ root, env });
      await server.start(process.stdin, process.stdout);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Framework-owned read-only recall server (hidden verb) — the agent's pull-on-
  // demand structure-layer access (quick-memory / workflows / session manifest),
  // root-confined. Spawned by delegate.js when the agent has quick-memory. Not in usage().
  if (command === 'serve-recall') {
    try {
      const { createRecallServer } = await import('./recall-mcp.js');
      const server = createRecallServer({ root, env });
      await server.start(process.stdin, process.stdout);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'serve-a2a') {
    const strictFlag = argv.includes('--strict');
    try {
      const { createA2AStdioServer } = await import('./a2a/stdio-server.js');
      const server = await createA2AStdioServer({ root, env, strict: strictFlag });
      await server.start(process.stdin, process.stdout);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const { createMcpServer } = await import('./mcp.js');
  const server = await createMcpServer({ root, env });
  await server.start(process.stdin, process.stdout);
}
