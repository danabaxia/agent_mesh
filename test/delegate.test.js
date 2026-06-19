import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delegateTask, resolveMeshRoot, parseResultEnvelope } from '../src/delegate.js';
import { readRunLogRecords } from '../src/log.js';
import { readEvents } from '../src/session-provenance.js';

const execFileAsync = promisify(execFile);

test('delegateTask ask mode invokes claude with read-only tools and writes a log', async () => {
  const root = await createGitRepo();
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        docstore: {
          command: 'node',
          args: ['tools/docstore/server.mjs'],
          'x-agentmesh': { readOnly: true }
        },
        search: {
          command: 'node',
          args: ['tools/search/server.mjs'],
          'x-agentmesh': { readOnly: true }
        }
      }
    })
  );
  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const mcpIndex = process.argv.indexOf('--mcp-config');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      argv: process.argv.slice(2),
      mcpConfig: process.argv[mcpIndex + 1],
      depth: process.env.AGENT_MESH_DEPTH,
      path: process.env.AGENT_MESH_PATH,
      mode: process.env.AGENT_MESH_MODE
    }));
    console.log('analysis complete');
  `);

  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: fakeClaude,
      AGENT_MESH_DEPTH: '2',
      CAPTURE_PATH: join(root, 'capture.json')
    },
    input: { mode: 'ask', task: 'inspect only', path: [], depth: 999 }
  });

  assert.equal(result.status, 'done');
  assert.equal(result.summary, 'analysis complete');
  assert.deepEqual(result.files_changed, ['capture.json']);
  assert.match(result.log_path, /\.agent-mesh[/\\]logs[/\\]delegate-/);

  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  // ask mode argv: now includes --settings + --setting-sources "" (Task 9) but
  // still no --permission-mode.
  const settingsIdx = capture.argv.indexOf('--settings');
  assert.notEqual(settingsIdx, -1);
  const sourcesIdx = capture.argv.indexOf('--setting-sources');
  assert.notEqual(sourcesIdx, -1);
  assert.equal(capture.argv[sourcesIdx + 1], '');
  assert.equal(capture.argv.includes('--permission-mode'), false);
  // Spawn tagging (2026-06-13): a --session-id <uuid> pair is injected after
  // --tools for every sessionless delegation so the transcript is identifiable
  // as worker-origin. Verify the prefix up to --tools, then skip the id pair,
  // then verify the rest of the early invocation flags.
  assert.deepEqual(capture.argv.slice(0, 4), ['-p', 'inspect only', '--tools', 'Read,Glob,Grep,LS,Skill']);
  assert.equal(capture.argv[4], '--session-id');
  assert.match(capture.argv[5], /^[0-9a-f-]{36}$/);
  assert.deepEqual(capture.argv.slice(6, 11), [
    '--strict-mcp-config',
    '--mcp-config',
    capture.mcpConfig,
    '--allowedTools',
    'mcp__docstore,mcp__search'
  ]);
  const mcpConfig = JSON.parse(await readFile(capture.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ['docstore', 'search']);
  // The framework strips its own read-only marker before handing the config to
  // claude — the emitted entry carries only standard server fields.
  assert.deepEqual(mcpConfig.mcpServers.docstore, {
    command: 'node',
    args: ['tools/docstore/server.mjs']
  });
  assert.equal(capture.depth, '1');
  assert.equal(capture.path, root);
  assert.equal(capture.mode, 'ask');

  // Grouped per-date NDJSON: result.log_path is the day's file; find this run's
  // final record by its run_id.
  const recs = await readRunLogRecords(result.log_path);
  const log = recs.find((r) => r.id === result.run_id && r.state === 'done');
  assert.equal(log.result.status, 'done');
  assert.equal(log.stdout.trim(), 'analysis complete');
});

test('delegateTask do mode exposes write tools, hook settings, and detects dirty-file content changes', async () => {
  const root = await createGitRepo();
  await writeFile(join(root, 'existing.txt'), 'before');
  await git(root, ['add', 'existing.txt']);

  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    await fs.writeFile('existing.txt', 'after');
    await fs.writeFile('created.txt', 'new');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      argv: process.argv.slice(2),
      settingsIndex: process.argv.indexOf('--settings'),
      settings: process.argv[process.argv.indexOf('--settings') + 1] || null
    }));
    console.log('changed files');
  `);

  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: fakeClaude,
      // Deterministic non-Windows preflight so do-mode runs on a Windows host too
      // (else the win32 managed-policy preflight refuses before claude spawns).
      AGENT_MESH_TEST_PLATFORM: 'linux',
      CAPTURE_PATH: join(root, 'capture.json')
    },
    input: { mode: 'do', task: 'modify local files' }
  });

  assert.equal(result.status, 'done');
  assert.equal(result.preexisting_dirty, true);
  assert.deepEqual(result.files_changed, ['capture.json', 'created.txt', 'existing.txt']);

  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  // Spawn tagging (2026-06-13): --session-id <uuid> is injected at index 4-5.
  assert.deepEqual(capture.argv.slice(0, 4), [
    '-p', 'modify local files', '--tools',
    'Read,Glob,Grep,LS,Edit,Write,MultiEdit,NotebookEdit,Skill'
  ]);
  assert.equal(capture.argv[4], '--session-id');
  assert.match(capture.argv[5], /^[0-9a-f-]{36}$/);
  assert.deepEqual(capture.argv.slice(6), [
    '--strict-mcp-config',
    '--mcp-config',
    capture.argv[8],
    '--settings',
    capture.settings,
    '--setting-sources',
    '',
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits'
  ]);
  assert.ok(capture.settingsIndex > -1);
  assert.ok(capture.settings);
  const settings = JSON.parse(await readFile(capture.settings, 'utf8'));
  assert.equal(settings.disableAllHooks, false);
  assert.equal(settings.env.AGENT_MESH_ROOT, root);
  assert.match(settings.env.AGENT_MESH_HOOK_LOG, /\.agent-mesh[/\\]logs[/\\]path-guard-denials\.jsonl$/);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
});

test('delegateTask returns the non-git files_changed note', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-nongit-'));
  const fakeClaude = await createFakeClaude(`
    console.log('no git here');
  `);

  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: fakeClaude
    },
    input: { mode: 'ask', task: 'inspect non-git folder' }
  });

  assert.equal(result.status, 'done');
  assert.equal(result.files_changed, null);
  assert.equal(result.note, 'untracked (not a git repo)');
});

test('delegateTask refuses nested do from an ask parent', async () => {
  const root = await createGitRepo();
  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_MODE: 'ask'
    },
    input: { mode: 'do', task: 'write anyway' }
  });

  assert.equal(result.status, 'refused');
  assert.equal(result.error.code, 'readonly_parent');
});

test('delegateTask returns timeout status with partial output', async () => {
  const root = await createGitRepo();
  const fakeClaude = await createFakeClaude(`
    process.stdout.write('started long task\\n');
    setInterval(() => {}, 1000);
  `);

  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: fakeClaude,
      AGENT_MESH_TIMEOUT_MS: '500'
    },
    input: { mode: 'ask', task: 'wait too long' }
  });

  assert.equal(result.status, 'timeout');
  assert.match(result.summary, /Timed out/);
  assert.match(result.summary, /started long task/);
  assert.deepEqual(result.files_changed, []);
});

test('delegateTask retries once when the claude binary is briefly missing (auto-update race)', async () => {
  // Observed live: npm's auto-updater swaps bin/claude.exe and a delegation
  // spawned during the swap window fails with ENOENT although the binary is
  // back seconds later. The delegate must ride out the window with one
  // delayed retry.
  const root = await createGitRepo();
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-flaky-'));
  const lateClaude = join(dir, 'late-claude.mjs');
  // The binary "appears" 300 ms after the first (failing) spawn attempt.
  setTimeout(() => {
    writeFile(lateClaude, `#!/usr/bin/env node\nprocess.stdout.write('late but alive');\n`, 'utf8');
  }, 300);
  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: lateClaude,
      AGENT_MESH_SPAWN_RETRY_MS: '900',
      // Faithfully reproduce the LIVE signature: the real claude is a concrete
      // `.exe`/bare command, so the updater deleting it makes spawn raise a
      // `spawn … ENOENT` error EVENT. A `.mjs` fake is rerouted to `node <path>`
      // (always present) and only yields exit-1/MODULE_NOT_FOUND, which the
      // retry must NOT key on. This seam makes an ABSENT fake path produce the
      // identical ENOENT the backoff retry actually rides out.
      AGENT_MESH_TEST_SPAWN_ENOENT_WHEN_ABSENT: '1'
    },
    input: { mode: 'ask', task: 'survive the update window' }
  });
  assert.equal(result.status, 'done');
  assert.match(result.summary, /late but alive/);
});

test('delegateTask survives an update window LONGER than one retry (backoff, recurrence 2026-06-11)', async () => {
  // The single 1.5s retry was beaten by a real update window (a2a log
  // 2026-06-12T02:42Z: spawn ENOENT, 6s run, retry also missed). The retry is
  // now a backoff SCHEDULE (base, x2, x4 ...) so the swap window is covered.
  // Here: base 250ms → attempts at ~0ms (fail), ~250ms (fail), ~750ms (the
  // binary appears at 600ms → third attempt succeeds).
  const root = await createGitRepo();
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-flaky2-'));
  const lateClaude = join(dir, 'very-late-claude.mjs');
  setTimeout(() => {
    writeFile(lateClaude, `#!/usr/bin/env node\nprocess.stdout.write('survived long swap');\n`, 'utf8');
  }, 600);
  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: lateClaude,
      AGENT_MESH_SPAWN_RETRY_MS: '250',
      // See note above: surface an absent `.mjs` fake as the real `spawn … ENOENT`
      // so the multi-step backoff (250ms → 500ms) is exercised across the swap
      // window the way the live concrete-binary race would be.
      AGENT_MESH_TEST_SPAWN_ENOENT_WHEN_ABSENT: '1'
    },
    input: { mode: 'ask', task: 'survive a long update window' }
  });
  assert.equal(result.status, 'done');
  assert.match(result.summary, /survived long swap/);
});

test('delegateTask reports spawn failures as data', async () => {
  const root = await createGitRepo();
  const result = await delegateTask({
    root,
    env: {
      AGENT_MESH_CLAUDE: join(root, 'missing-claude')
    },
    input: { mode: 'ask', task: 'will not spawn' }
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'spawn_failed');
  assert.match(result.error.message, /ENOENT/);
});

test('delegateTask forward-maintains the per-agent session manifest (spec §7, change-detection-excluded)', async () => {
  const root = await createGitRepo();
  const fakeClaude = await createFakeClaude(`console.log('done');`);
  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude },
    input: { mode: 'ask', task: 'inspect the repo' },
    route: 'probe'
  });
  assert.equal(result.status, 'done');
  // The manifest lives under .agent-mesh/ → it must NOT count as agent work.
  assert.deepEqual(result.files_changed, []);

  const manifest = JSON.parse(await readFile(join(root, '.agent-mesh', 'sessions', 'index.json'), 'utf8'));
  assert.equal(manifest.sessions.length, 1);
  const entry = manifest.sessions[0];
  assert.equal(entry.origin, 'worker:probe');
  assert.equal(entry.status, 'active');
  assert.deepEqual(entry.run_ids, [result.run_id]);
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
});

async function createGitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-delegate-'));
  await git(root, ['init']);
  return root;
}

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd });
}

async function createFakeClaude(body) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-fake-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

// Spin up a disposable workspace + fake claude that copies the file passed to
// `--settings` to a known location, so tests can inspect the merged settings.
// Also captures the fake claude's argv to a known location so tests can inspect
// invocation flags directly.
async function setupHarness({ mode, fakeHome, managedFile, forcePlatform, extraEnv } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'delegate-test-'));
  const home = join(work, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  if (fakeHome) {
    for (const [name, val] of Object.entries(fakeHome)) {
      await writeFile(join(home, '.claude', name), JSON.stringify(val), 'utf8');
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'delegate-test-root-'));
  const settingsCapture = join(work, 'captured-settings.json');
  const argvCapture = join(work, 'captured-argv.json');
  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    await fs.writeFile(${JSON.stringify(argvCapture)}, JSON.stringify(process.argv.slice(2)));
    const i = process.argv.indexOf('--settings');
    if (i !== -1) {
      await fs.copyFile(process.argv[i + 1], ${JSON.stringify(settingsCapture)});
    }
    console.log('ok');
  `);
  const env = { AGENT_MESH_CLAUDE: fakeClaude, HOME: home };
  if (managedFile) {
    const managedPath = join(work, 'managed-settings.json');
    await writeFile(managedPath, JSON.stringify(managedFile), 'utf8');
    env.AGENT_MESH_TEST_MANAGED_FILE = managedPath;
  }
  // Default the managed-policy preflight to a deterministic NON-Windows platform so
  // these delegate-logic tests are host-independent. On a real Windows host the
  // win32 preflight refuses every `do` task before claude runs (claude never spawns
  // → capture files never written → ENOENT), and gives a win32-specific refusal
  // reason. The win32-specific tests pass forcePlatform: 'win32' explicitly.
  env.AGENT_MESH_TEST_PLATFORM = forcePlatform || 'linux';
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (env[k] === undefined) env[k] = v;
    }
  }
  return {
    runDelegate: (task) =>
      delegateTask({ root, env, input: { mode, task }, parentRunId: null }),
    readSettings: () => JSON.parse(readFileSync(settingsCapture, 'utf8')),
    lastArgv: () => JSON.parse(readFileSync(argvCapture, 'utf8')),
  };
}

test('delegate do: --settings carries PreToolUse in exec form (command + args)', async () => {
  const { runDelegate, readSettings } = await setupHarness({ mode: 'do' });
  await runDelegate('any task');
  const settings = readSettings();
  const entries = settings.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  const hookEntry = entries[0].hooks[0];
  assert.equal(hookEntry.type, 'command');
  assert.equal(hookEntry.command, process.execPath);
  assert.ok(Array.isArray(hookEntry.args));
  assert.equal(hookEntry.args.length, 1);
  assert.ok(hookEntry.args[0].replace(/\\/g, '/').endsWith('hooks/path-guard.js'));
});

test('delegate ask: --settings carries empty hooks {} (no PreToolUse)', async () => {
  const { runDelegate, readSettings } = await setupHarness({ mode: 'ask' });
  await runDelegate('any task');
  const settings = readSettings();
  assert.deepEqual(settings.hooks, {});
  assert.equal(settings.disableAllHooks, false);
});

test('delegate ask: argv includes --settings + --setting-sources "" + --tools', async () => {
  const { runDelegate, lastArgv } = await setupHarness({ mode: 'ask' });
  await runDelegate('any');
  const argv = lastArgv();
  assert.ok(argv.includes('--settings'));
  const i = argv.indexOf('--setting-sources');
  assert.notEqual(i, -1, '--setting-sources flag present');
  assert.equal(argv[i + 1], '', '--setting-sources value is empty string (disables native sources)');
  assert.ok(argv.includes('--tools'));
  assert.equal(argv.includes('--permission-mode'), false);
});

test('delegate do: argv excludes Bash from --tools even with author plugin', async () => {
  const { runDelegate, lastArgv } = await setupHarness({
    mode: 'do',
    fakeHome: { 'settings.json': { enabledPlugins: { 'bashy@x': true } } },
  });
  await runDelegate('any');
  const argv = lastArgv();
  const i = argv.indexOf('--tools');
  assert.notEqual(i, -1);
  const tools = argv[i + 1].split(',');
  assert.equal(tools.includes('Bash'), false);
  assert.ok(tools.includes('Edit') && tools.includes('Write'));
});

test('delegate do: author enabledPlugins flows into --settings', async () => {
  const { runDelegate, readSettings } = await setupHarness({
    mode: 'do',
    fakeHome: { 'settings.json': { enabledPlugins: { 'my-plugin@my-mkt': true } } },
  });
  await runDelegate('any task');
  const settings = readSettings();
  assert.deepEqual(settings.enabledPlugins, { 'my-plugin@my-mkt': true });
});

test('delegateTask do mode grants no .mcp.json tool servers (default-deny)', async () => {
  const root = await createGitRepo();
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { docstore: { command: 'node', args: ['tools/docstore/server.mjs'] } } })
  );
  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const i = process.argv.indexOf('--mcp-config');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      argv: process.argv.slice(2),
      mcpConfig: process.argv[i + 1]
    }));
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, AGENT_MESH_TEST_PLATFORM: 'linux', CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'do', task: 'change files' }
  });

  assert.equal(result.status, 'done');
  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(capture.mcpConfig, 'utf8'));
  assert.deepEqual(mcp.mcpServers, {});
  assert.equal(capture.argv.includes('--allowedTools'), false);
});

test('delegateTask ask mode does not grant declared servers without an explicit read-only marker', async () => {
  const root = await createGitRepo();
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        unmarked: { command: 'node', args: ['tools/unmarked/server.mjs'] },
        writey: { command: 'node', args: ['tools/writey/server.mjs'], 'x-agentmesh': { readOnly: false } },
        reader: { command: 'node', args: ['tools/reader/server.mjs'], 'x-agentmesh': { readOnly: true } }
      }
    })
  );
  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const i = process.argv.indexOf('--mcp-config');
    const a = process.argv.indexOf('--allowedTools');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      mcpConfig: process.argv[i + 1],
      allowed: a > -1 ? process.argv[a + 1] : null
    }));
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'ask', task: 'inspect only' }
  });

  assert.equal(result.status, 'done');
  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(capture.mcpConfig, 'utf8'));
  // Only the explicitly read-only server is exposed; unmarked and readOnly:false are withheld.
  assert.deepEqual(Object.keys(mcp.mcpServers), ['reader']);
  assert.equal(capture.allowed, 'mcp__reader');
});

test('delegateTask injects prompts/system.md and prompts/<mode>.md as --append-system-prompt', async () => {
  const root = await createGitRepo();
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'system.md'), 'You are the library agent.');
  await writeFile(join(root, 'prompts', 'ask.md'), 'Answer read-only from the catalog.');

  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const i = process.argv.indexOf('--append-system-prompt');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      hasFlag: i > -1,
      prompt: i > -1 ? process.argv[i + 1] : null
    }));
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'ask', task: 'find a book' }
  });

  assert.equal(result.status, 'done');
  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  assert.equal(capture.hasFlag, true);
  assert.match(capture.prompt, /You are the library agent\./);
  assert.match(capture.prompt, /Answer read-only from the catalog\./);
  assert.ok(
    capture.prompt.indexOf('You are the library agent.') <
      capture.prompt.indexOf('Answer read-only from the catalog.')
  );
});

// Chunk 2: verify the new agent-context prompt assembly is wired into delegate.
// Specifically: memory/ and workflows/ contents (which the legacy
// readIdentityPrompt never read) now flow through --append-system-prompt.
test('delegateTask injects memory/ and workflows/ contents via buildAgentRuntimePrompt', async () => {
  const root = await createGitRepo();
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'system.md'), 'SYSTEM_LINE');
  await writeFile(join(root, 'prompts', 'ask.md'), 'ASK_LINE');
  await mkdir(join(root, 'memory'), { recursive: true });
  await writeFile(join(root, 'memory', 'profile.md'), 'PROFILE_LINE');
  await writeFile(join(root, 'memory', 'catalog-policy.md'), 'CATALOG_POLICY_LINE');
  await mkdir(join(root, 'workflows'), { recursive: true });
  await writeFile(join(root, 'workflows', 'default.md'), 'DEFAULT_WORKFLOW_LINE');
  await writeFile(join(root, 'workflows', 'ask.md'), 'ASK_WORKFLOW_LINE');

  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const i = process.argv.indexOf('--append-system-prompt');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      prompt: i > -1 ? process.argv[i + 1] : null
    }));
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'ask', task: 'find a book' }
  });

  assert.equal(result.status, 'done');
  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  const expectedOrder = [
    'SYSTEM_LINE',
    'PROFILE_LINE',
    'CATALOG_POLICY_LINE',
    'DEFAULT_WORKFLOW_LINE',
    'ASK_WORKFLOW_LINE',
    'ASK_LINE'
  ];
  let cursor = -1;
  for (const marker of expectedOrder) {
    const idx = capture.prompt.indexOf(marker, cursor + 1);
    assert.ok(idx > cursor, `expected "${marker}" after position ${cursor}, got ${idx}`);
    cursor = idx;
  }
});

test('delegate do refused when managed disableAllHooks: true', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    managedFile: { disableAllHooks: true },
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'incompatible_managed_policy');
});

test('delegate do refused when managed allowManagedHooksOnly: true', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    managedFile: { allowManagedHooksOnly: true },
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
});

test('delegate do refused when managed hooks.PreToolUse overlaps WRITE_TOOLS', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    managedFile: { hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '/x' }] }] } },
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
});

test('delegate ask NOT refused by the same managed policy', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'ask',
    managedFile: { disableAllHooks: true },
  });
  const result = await runDelegate('any');
  assert.notEqual(result.status, 'refused');
});

test('delegate do on Windows fixture without attestation → refused', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    forcePlatform: 'win32',
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'managed_policy_unverifiable_windows');
});

test('delegate do on Windows WITH AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1 → proceeds', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    forcePlatform: 'win32',
    extraEnv: { AGENT_MESH_ATTEST_MANAGED_COMPATIBLE: '1' },
  });
  const result = await runDelegate('any');
  assert.notEqual(result.status, 'refused');
});

test('resolveMeshRoot stops at AGENT_MESH_MESH_CEILING and does not walk above it', async () => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'mesh-ceiling-')));
  await mkdir(join(outer, 'mesh'), { recursive: true });
  const inner = join(outer, 'inner');
  const agent = join(inner, 'agent');
  await mkdir(agent, { recursive: true });

  // No ceiling: walk-up finds outer/mesh.
  assert.equal(await resolveMeshRoot(agent, {}), join(outer, 'mesh'));
  // Ceiling at inner: walk stops there (no mesh/ in inner) and never reaches outer/mesh.
  assert.equal(await resolveMeshRoot(agent, { AGENT_MESH_MESH_CEILING: inner }), null);
  // Explicit AGENT_MESH_MESH_ROOT override always wins.
  assert.equal(
    await resolveMeshRoot(agent, { AGENT_MESH_MESH_ROOT: join(outer, 'mesh') }),
    join(outer, 'mesh')
  );
});

test('sessionless delegations are tagged: --session-id generated + worker:<route> provenance', async () => {
  const root = await createGitRepo();
  const fakeClaude = await createFakeClaude(`console.log('done');`);
  const envWithFakeClaude = {
    AGENT_MESH_CLAUDE: fakeClaude,
    AGENT_MESH_TEST_PLATFORM: 'linux',
  };
  const meshCeiling = await mkdtemp(join(tmpdir(), 'tagmesh-'));
  const r = await delegateTask({
    root, env: { ...envWithFakeClaude, AGENT_MESH_MESH_CEILING: meshCeiling },
    input: { mode: 'ask', task: 'hi' }, route: 'digest'
  });
  assert.equal(r.status, 'done');
  // argv is stored compacted in the run log; check via log_path
  const recs = await readRunLogRecords(r.log_path);
  const log = recs.find((rec) => rec.id === r.run_id && rec.state === 'done');
  assert.ok(log, 'run log final record found');
  assert.match(JSON.stringify(log.argv), /--session-id/, '--session-id present in logged argv');
  const events = await readEvents(meshCeiling);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'create');
  assert.equal(events[0].source, 'worker:digest');
  assert.match(events[0].sessionId, /^[0-9a-f-]{36}$/);
});

test('tagging: no mesh env → no event but delegation fine; explicit session untouched; route absent → worker:<mode>', async () => {
  const root = await createGitRepo();
  const fakeClaude = await createFakeClaude(`console.log('done');`);
  const envWithFakeClaude = {
    AGENT_MESH_CLAUDE: fakeClaude,
    AGENT_MESH_TEST_PLATFORM: 'linux',
  };
  // No AGENT_MESH_MESH_CEILING → no event, but delegation succeeds
  const r = await delegateTask({ root, env: envWithFakeClaude, input: { mode: 'ask', task: 'hi' } });
  assert.equal(r.status, 'done');
  const explicitId = 'eeeeeeee-1111-4222-8333-444444444444';
  const meshCeiling = await mkdtemp(join(tmpdir(), 'tagmesh2-'));
  // Explicit session → caller owns provenance; no event written
  const r2 = await delegateTask({ root, env: { ...envWithFakeClaude, AGENT_MESH_MESH_CEILING: meshCeiling },
    input: { mode: 'ask', task: 'hi' }, session: { id: explicitId, resume: false } });
  assert.equal(r2.status, 'done');
  assert.equal((await readEvents(meshCeiling)).length, 0); // explicit session → caller owns provenance
  // No route → source falls back to worker:<mode>
  const r3 = await delegateTask({ root, env: { ...envWithFakeClaude, AGENT_MESH_MESH_CEILING: meshCeiling },
    input: { mode: 'ask', task: 'hi' } });
  assert.equal(r3.status, 'done');
  const evs = await readEvents(meshCeiling);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].source, 'worker:ask'); // route null → mode fallback
});

// ── Token/cost capture (spec 2026-06-13-delegate-cost-capture) ────────────────

test('parseResultEnvelope: valid envelope → summary + normalized usage', () => {
  const env = parseResultEnvelope(JSON.stringify({
    type: 'result', subtype: 'success', result: 'hello world',
    session_id: 'abc', num_turns: 2, duration_ms: 900, duration_api_ms: 500,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 }
  }));
  assert.equal(env.summary, 'hello world');
  assert.deepEqual(env.usage, {
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2,
    total_cost_usd: 0.0123, num_turns: 2, duration_api_ms: 500, session_id: 'abc'
  });
});

test('parseResultEnvelope: non-envelope inputs → null (text fallback path)', () => {
  assert.equal(parseResultEnvelope('analysis complete'), null);   // bare text (a text-mode fake)
  assert.equal(parseResultEnvelope(''), null);
  assert.equal(parseResultEnvelope('   '), null);
  assert.equal(parseResultEnvelope('{not json'), null);           // truncated by a timeout
  assert.equal(parseResultEnvelope('[1,2,3]'), null);             // JSON, but not an object
  assert.equal(parseResultEnvelope('{"foo":"bar"}'), null);       // object, but not a result envelope
});

test('parseResultEnvelope: usage-only envelope (no string result) → summary null, usage present', () => {
  const env = parseResultEnvelope(JSON.stringify({
    subtype: 'error_max_turns', total_cost_usd: 0.02, usage: { input_tokens: 99 }
  }));
  assert.equal(env.summary, null);
  assert.equal(env.usage.total_cost_usd, 0.02);
  assert.equal(env.usage.input_tokens, 99);
});

test('delegateTask: JSON result envelope → usage captured in result, run record, summary from .result', async () => {
  const root = await createGitRepo();
  // A fake claude that emits the --output-format json terminal envelope.
  const fakeClaude = await createFakeClaude(
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'the planted answer', ` +
    `session_id: 'sess-1', num_turns: 3, duration_ms: 8000, duration_api_ms: 7044, total_cost_usd: 0.0214, ` +
    `usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } }));`
  );
  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, AGENT_MESH_TEST_PLATFORM: 'linux' },
    input: { mode: 'ask', task: 'q' }
  });
  assert.equal(result.status, 'done');
  // summary comes from the envelope's `.result`, not the raw JSON line.
  assert.equal(result.summary, 'the planted answer');
  assert.equal(result.usage.total_cost_usd, 0.0214);
  assert.equal(result.usage.input_tokens, 1200);
  assert.equal(result.usage.output_tokens, 340);
  assert.equal(result.usage.cache_read_input_tokens, 100);
  assert.equal(result.usage.num_turns, 3);
  assert.equal(result.usage.duration_api_ms, 7044);
  // The worker argv carries --output-format json.
  const recs = await readRunLogRecords(result.log_path);
  const log = recs.find((r) => r.id === result.run_id && r.state === 'done');
  assert.match(JSON.stringify(log.argv), /--output-format","json/);
  // Run record carries usage top-level for cheap reads.
  assert.equal(log.usage.total_cost_usd, 0.0214);
  assert.equal(log.usage.input_tokens, 1200);
});

test('delegateTask: non-envelope (text) output → usage null, summary is the text (fallback)', async () => {
  const root = await createGitRepo();
  const fakeClaude = await createFakeClaude(`console.log('plain text answer');`);
  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, AGENT_MESH_TEST_PLATFORM: 'linux' },
    input: { mode: 'ask', task: 'q' }
  });
  assert.equal(result.status, 'done');
  assert.equal(result.summary, 'plain text answer');
  assert.equal(result.usage, undefined);            // no envelope → no usage on the result
  const recs = await readRunLogRecords(result.log_path);
  const log = recs.find((r) => r.id === result.run_id && r.state === 'done');
  assert.equal(log.usage, null);                    // run record records null, not absent
});

test('delegateTask do mode: aggregateDownstreamChanges reads a2a log records by parent_run_id', async () => {
  // B3: hermetic test for the aggregateDownstreamChanges read path.
  // The fakeClaude seeds the a2a log with a synthetic done record whose
  // parent_run_id matches the outer run's AGENT_MESH_RUN_ID, then
  // delegateTask must surface it as result.downstream_changes.
  const root = await createGitRepo();
  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const date = new Date().toISOString().slice(0, 10);
    const logDir = path.join(process.cwd(), '.agent-mesh', 'logs');
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, 'a2a-' + date + '.jsonl');
    const record = JSON.stringify({
      kind: 'a2a', to: 'lib-peer', state: 'done',
      parent_run_id: process.env.AGENT_MESH_RUN_ID,
      peer_changes: ['src/foo.ts', 'src/bar.ts'],
      best_effort: false
    });
    await fs.appendFile(logFile, record + '\\n', 'utf8');
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, AGENT_MESH_TEST_PLATFORM: 'linux' },
    input: { mode: 'do', task: 'change peer files' }
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(result.downstream_changes, [
    { peer: 'lib-peer', files_changed: ['src/foo.ts', 'src/bar.ts'], best_effort: false }
  ]);
});
