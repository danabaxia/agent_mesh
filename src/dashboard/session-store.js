/**
 * src/dashboard/session-store.js
 * Canonical session-id record per agent, stored under the runtime temp state dir.
 * One id per agent, resumed by every entry point.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

export function sessionPaths(meshRoot, agentRoot) {
  const dir = join(tmpdir(), 'agent-mesh', 'sessions', hash(meshRoot));
  const key = hash(agentRoot);
  return { dir, jsonPath: join(dir, `${key}.json`), lockPath: join(dir, `${key}.lock`) };
}

export async function readSessionId(meshRoot, agentRoot) {
  try {
    const { jsonPath } = sessionPaths(meshRoot, agentRoot);
    const rec = JSON.parse(await readFile(jsonPath, 'utf8'));
    return typeof rec.sessionId === 'string' ? rec.sessionId : null;
  } catch { return null; }
}

export async function writeSessionId(meshRoot, agentRoot, sessionId) {
  const { dir, jsonPath } = sessionPaths(meshRoot, agentRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ sessionId, updatedAt: Date.now() }) + '\n', { mode: 0o600 });
}
