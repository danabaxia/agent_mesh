import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const MAX_TURN_CHARS = 4000;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TTL_MS = 86_400_000; // 24h

function storeDir(root) {
  return join(root, '.agent-mesh', 'voice-history');
}
function storePath(root, contextId) {
  // contextId is caller-controlled → hash it to a safe filename.
  const safe = createHash('sha256').update(String(contextId)).digest('hex').slice(0, 32);
  return join(storeDir(root), `${safe}.json`);
}

async function readTurns(root, contextId) {
  try {
    const arr = JSON.parse(await readFile(storePath(root, contextId), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function prune(turns, { maxTurns, ttlMs, now }) {
  const fresh = turns.filter((t) => t && typeof t.ts === 'number' && now - t.ts <= ttlMs);
  return fresh.slice(Math.max(0, fresh.length - maxTurns));
}

/** Load capped, non-expired history (oldest-first). Never throws. */
export async function loadHistory(root, contextId, opts = {}) {
  const { maxTurns = DEFAULT_MAX_TURNS, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = opts;
  return prune(await readTurns(root, contextId), { maxTurns, ttlMs, now }).map((t) => ({
    role: t.role === 'assistant' ? 'assistant' : 'user',
    text: String(t.text ?? ''),
    ts: t.ts,
  }));
}

/** Append one turn atomically, pruning with TTL+cap. */
export async function appendTurn(root, contextId, turn, opts = {}) {
  const { maxTurns = DEFAULT_MAX_TURNS, ttlMs = DEFAULT_TTL_MS } = opts;
  let now = typeof opts.now === 'number' ? opts.now : Date.now();
  const entry = {
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    text: String(turn.text ?? '').slice(0, MAX_TURN_CHARS),
    ts: typeof turn.ts === 'number' ? turn.ts : now,
  };
  // Use entry's ts as the reference point if now wasn't explicitly provided.
  if (typeof opts.now !== 'number') {
    now = entry.ts;
  }
  const next = prune([...(await readTurns(root, contextId)), entry], { maxTurns, ttlMs, now });
  await mkdir(storeDir(root), { recursive: true });
  const path = storePath(root, contextId);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(next));
  await rename(tmp, path); // atomic single-writer replace
}
