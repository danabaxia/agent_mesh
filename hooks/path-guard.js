#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isPathInsideRoot, isProtectedConfigPath, extractToolPaths } from '../src/path-guard.js';

const root = process.env.AGENT_MESH_ROOT;

if (!root) {
  await deny('AGENT_MESH_ROOT is not set.');
} else {
  const payload = await readStdinJson();
  const toolName = payload?.tool_name || payload?.toolName || payload?.name;
  const toolInput = payload?.tool_input || payload?.toolInput || payload?.input || {};
  const paths = extractToolPaths(toolName, toolInput);

  if (paths.length === 0) {
    await deny(`No canonicalizable path argument found for ${toolName || 'unknown tool'}.`);
  }

  for (const candidate of paths) {
    if (!(await isPathInsideRoot(root, candidate))) {
      await deny(`Write denied outside agent-mesh root: ${candidate}`);
    }
    // Boundary 5: even inside the root, a delegated `do` task may not rewrite the
    // agent's own trusted configuration (prompts/agent.json/.mcp.json/
    // registry.json/tools/memory/workflows/skills). This hook only runs in `do`
    // mode, so the check is implicitly mode-scoped.
    if (await isProtectedConfigPath(root, candidate)) {
      await deny(`Write denied to protected agent config: ${candidate}`);
    }
  }

  allow();
}

async function readStdinJson() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text || '{}');
  } catch {
    await deny('Hook input was not valid JSON.');
  }
}

function allow() {
  process.exit(0);
}

async function deny(reason) {
  await logDenial(reason);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function logDenial(reason) {
  const logPath = process.env.AGENT_MESH_HOOK_LOG;
  if (!logPath) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `${JSON.stringify({ ts: new Date().toISOString(), root, reason })}\n`,
      'utf8'
    );
  } catch {
    // Denial must not become allow just because audit logging failed.
  }
}
