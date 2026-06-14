// src/a2a/session-id.js
//
// Deterministic per-caller `claude` session identity for multi-turn peer
// sessions (spec §3.2-3.4). C derives the session id purely from the
// conversation key + its own encoded project dir, so the right transcript is
// resumed across the bridge's per-call teardown and future runs — with NO
// in-memory state. `new_conversation` is a durable reset via a per-caller epoch
// file persisted atomically on C.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../atomic-write.js';

// RFC-4122 v5 (SHA-1, name-based). namespace is a 16-byte Buffer; name a string.
function uuidv5(name, namespaceBytes) {
  const h = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;        // version 5
  b[8] = (b[8] & 0x3f) | 0x80;        // variant 10
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A fixed 16-byte namespace seed for agent-mesh peer sessions (any constant works;
// this keeps our ids out of any well-known namespace).
const MESH_NS = createHash('sha1').update('agent-mesh/peer-session').digest().subarray(0, 16);

/**
 * Deterministic claude session UUID for (conversationKey, encodedAgentRoot).
 * encodedRoot MUST be the encodeProjectDir() form so the id agrees with the
 * transcript lookup even under Windows drive-letter casing drift.
 */
export function deriveSessionId(conversationKey, encodedRoot) {
  const ns = uuidv5(String(encodedRoot), MESH_NS);          // per-peer namespace (string→uuid)
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  return uuidv5(String(conversationKey), nsBytes);
}

// ── per-caller epoch store: one tiny file per caller, atomic temp+rename ──────
function epochDir(agentRoot) { return join(agentRoot, '.agent-mesh', 'peer-epochs'); }
function epochFile(agentRoot, caller) {
  const safe = createHash('sha256').update(String(caller)).digest('hex').slice(0, 32);
  return join(epochDir(agentRoot), safe);
}

export async function readEpoch(agentRoot, caller) {
  try {
    const n = parseInt(await readFile(epochFile(agentRoot, caller), 'utf8'), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch { return 0; }               // missing/corrupt → 0 for THIS caller only
}

export async function persistEpoch(agentRoot, caller, n) {
  await atomicWriteFile(epochFile(agentRoot, caller), String(n));
}
