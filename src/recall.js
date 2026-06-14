// src/recall.js — the read-side confinement + resolver behind the framework recall
// verbs (spec §6). The security-critical piece: every target is realpath-confined
// under AGENT_MESH_ROOT and refused (as data — failure is data) if it resolves
// outside. This is the READ-side analog of hooks/path-guard.js.
//
//   recall({ key })          → <root>/memory/quick.json[key]   (live entry only)
//   load_workflow({ name })  → <root>/workflows/<name>.md
//   load_session({ id })     → a session id present in THIS agent's own manifest
//
// "Read-only" does NOT imply "root-confined" — so confinement is enforced
// explicitly here, not assumed from the lack of writes.
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { canonicalizePossiblyMissing } from './path-guard.js';
import { readQuickMemory, recall as recallEntry } from './quick-memory.js';
import { readManifest } from './session-manifest.js';

/** A structured refusal (failure is data — never throw across the verb boundary). */
const refused = (reason, detail) => ({ ok: false, refused: reason, detail: detail ?? null });
const ok = (value) => ({ ok: true, value });

/**
 * Confine `target` (an absolute or root-relative path) under realpath(root).
 * Returns the canonical path, or null if it escapes. Mirrors the path-guard:
 * realpath the root; resolve the target; require the canonical target to be the
 * root itself or strictly under it. We canonicalize the root (symlinks) and the
 * target's existing prefix; a non-existent leaf is fine (we only read existing
 * files, but resolve() + the prefix check still bounds traversal).
 */
export async function confinePath(root, target) {
  let canonRoot;
  try { canonRoot = await realpath(root); } catch { return null; }
  const abs = resolve(canonRoot, target);
  // EXACTLY mirror the write-side path-guard: realpath the deepest EXISTING ancestor
  // (resolving symlinked intermediate dirs) and re-append the missing tail, so a
  // symlinked-parent + missing-leaf can't escape — read side cannot drift from write.
  const canon = await canonicalizePossiblyMissing(abs);
  // Use the PLATFORM separator — canon/canonRoot are native paths (\ on Windows),
  // so a hardcoded '/' prefix check refuses every valid in-root path on win32.
  const withSep = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;
  if (canon === canonRoot || canon.startsWith(withSep)) return canon;
  return null;
}

/** Reject obviously-hostile identifiers before any fs touch (defense in depth). */
function badIdent(s) {
  return typeof s !== 'string' || s.length === 0 || s.includes('\0')
    || s.includes('/') || s.includes('\\') || s.includes('..');
}

/** recall({ key }) — a live quick-memory entry's full value + provenance.
 *  `key` is a JSON MAP LOOKUP into the fixed, framework-owned <root>/memory/quick.json
 *  — not a filesystem path — so there is no traversal surface to confine here; the
 *  store path is constant and never attacker-influenced. */
export async function recall(root, key) {
  if (typeof key !== 'string' || !key.length) return refused('bad_input', 'key required');
  const quick = await readQuickMemory(root);
  const hit = recallEntry(quick, key);
  if (!hit) return refused('not_found', `no live memory entry "${key}"`);
  return ok(hit);
}

/** load_workflow({ name }) — a workflow file under <root>/workflows/. */
export async function loadWorkflow(root, name) {
  if (badIdent(name)) return refused('bad_input', 'workflow name must be a bare slug');
  const path = await confinePath(root, join('workflows', `${name}.md`));
  if (!path) return refused('out_of_root', 'workflow path escapes root');
  // double-check the basename matches (no traversal slipped through)
  if (basename(path) !== `${name}.md`) return refused('out_of_root', 'unexpected resolved name');
  try { return ok({ name, content: await readFile(path, 'utf8') }); }
  catch { return refused('not_found', `no workflow "${name}"`); }
}

/** load_session({ id }) — restricted to ids present in THIS agent's own manifest;
 *  never an arbitrary UUID over the shared ~/.claude/projects tree. */
export async function loadSession(root, id) {
  if (badIdent(id)) return refused('bad_input', 'session id must be a bare id');
  const manifest = await readManifest(root);
  const entry = (manifest.sessions || []).find((s) => s.id === id);
  if (!entry) return refused('not_found', `session "${id}" not in this agent's manifest`);
  // Return the manifest entry (the L0/L1 doc-layer). Raw transcript bodies (L2) are
  // out of scope for v1 confinement — the manifest is the agent-scoped handle.
  return ok(entry);
}

/** Dispatch a verb by kind — the single entry point the MCP server calls. */
export async function recallVerb(root, kind, arg) {
  switch (kind) {
    case 'recall': return recall(root, arg?.key);
    case 'load_workflow': return loadWorkflow(root, arg?.name);
    case 'load_session': return loadSession(root, arg?.id);
    default: return refused('bad_input', `unknown recall verb "${kind}"`);
  }
}
