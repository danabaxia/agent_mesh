/**
 * src/skills-policy.js
 *
 * Per-agent skill allowlist (PERMISSION surface).
 *
 * Config home: the mesh manifest `mesh.json`, per agent entry, an OPTIONAL
 * field `skills` (string[]) next to `enabledModes`.
 *
 * Semantics:
 *   - field ABSENT      → ALL of the agent's discovered skills are allowed
 *                         (this is the bug-fix default — `Skill` was previously
 *                         never in --tools, so agents could not run any skill).
 *   - field = ["a","b"] → only those named skills are allowed.
 *   - field = []        → skills are fully disabled.
 *
 * Skill names are the skill's directory name under the agent's `skills/` dir and
 * the global `mesh/skills/` dir — this matches Claude Code's `Skill(<name>)`
 * matcher. Names used inside `Skill(...)` are sanitized to `[A-Za-z0-9._-]`
 * (any name containing a disallowed character is DROPPED) so a crafted skill
 * directory name cannot break out of the permission matcher.
 *
 * This module is pure-ish: filesystem reads (manifest + skill dirs) are the only
 * side effects, and they are injectable via the `io` parameter for testing.
 */

import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifest } from './builder/manifest.js';

// A skill name is the leaf directory name; the same charset Claude Code accepts
// in `Skill(<name>)`. Anything outside this set is rejected (dropped), never
// quoted/escaped — we never want a `)` or `*` to alter the matcher semantics.
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function isSafeSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name);
}

// Discover skill (sub)directory names that contain a SKILL.md under `dir`.
async function discoverSkillNames(dir, io) {
  const rd = io.readdir || readdir;
  let entries;
  try {
    entries = await rd(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.isDirectory()) continue;
    let inner;
    try {
      inner = await rd(join(dir, entry.name));
    } catch {
      continue;
    }
    if (inner.includes('SKILL.md')) names.push(entry.name);
  }
  return names;
}

async function safeRealpath(p, io) {
  const rp = io.realpath || realpath;
  try {
    return await rp(p);
  } catch {
    return p;
  }
}

/**
 * Resolve the effective skill policy for one agent.
 *
 * @param {string} agentRoot  canonical agent folder
 * @param {string|null} meshRoot  the mesh ROOT directory (the parent that holds
 *   `mesh.json` and the global `mesh/` dir), or null/undefined if there is no
 *   mesh layer. NOTE: this is the mesh root, NOT the `mesh/` subdir.
 * @param {object} [io]  { readManifest, readdir, realpath } injectable for tests
 * @returns {Promise<{ mode:'all'|'none'|'list', allow:string[] }>}
 */
export async function resolveSkillPolicy(agentRoot, meshRoot, io = {}) {
  // Discover available skill names from BOTH the agent's local skills/ and the
  // global mesh/skills/ dir. Deduplicate, keep sorted for determinism.
  const localNames = await discoverSkillNames(join(agentRoot, 'skills'), io);
  const globalNames = meshRoot
    ? await discoverSkillNames(join(meshRoot, 'mesh', 'skills'), io)
    : [];
  const discovered = [...new Set([...localNames, ...globalNames])].sort();

  // Find this agent's manifest entry (by realpath-compared root) to read its
  // optional `skills` field. Tolerate any failure → treat as absent (mode:all).
  let configured;
  if (meshRoot) {
    try {
      const read = io.readManifest || readManifest;
      const manifest = await read(meshRoot);
      const wantRoot = await safeRealpath(agentRoot, io);
      for (const entry of manifest?.agents ?? []) {
        if (typeof entry?.root !== 'string') continue;
        const entryRoot = await safeRealpath(join(meshRoot, entry.root), io);
        if (entryRoot === wantRoot) {
          configured = entry.skills;
          break;
        }
      }
    } catch {
      // manifest missing/unreadable → field absent → mode:all
    }
  }

  if (configured === undefined || configured === null) {
    return { mode: 'all', allow: discovered };
  }
  if (!Array.isArray(configured)) {
    // Malformed field → fail SAFE-ish to the bug-fix default (all). A non-array
    // is an author error; do not silently disable skills.
    return { mode: 'all', allow: discovered };
  }
  if (configured.length === 0) {
    return { mode: 'none', allow: [] };
  }
  // mode:list — use the configured names as the allowlist, preserving the
  // author's order. Drop names that fail sanitization (so a crafted name can
  // never reach the `Skill(...)` matcher). We do NOT intersect with discovered
  // names: a configured-but-not-yet-present skill stays allowed (the agent may
  // add it later), but it still must pass the charset check.
  const allow = configured.filter((n) => isSafeSkillName(n));
  return { mode: 'list', allow };
}

/**
 * Whether the `Skill` tool should be added to the headless `--tools` list.
 * True for every mode except 'none' (where the tool is omitted entirely).
 */
export function skillToolEnabled(policy) {
  return policy?.mode !== 'none';
}

/**
 * The settings `permissions` fragment that restricts skills, or null when no
 * restriction is needed.
 *   - mode:'all'  → null            (Skill in --tools, no permission gate)
 *   - mode:'none' → { deny:['Skill'] }
 *   - mode:'list' → { deny:['Skill'], allow:['Skill(a)','Skill(b)',...] }
 *     (deny-then-named-allow: deny wins by default, allow re-enables the named)
 */
export function skillPermissions(policy) {
  if (!policy || policy.mode === 'all') return null;
  if (policy.mode === 'none') return { deny: ['Skill'] };
  // mode:'list' — names already sanitized in resolveSkillPolicy.
  return {
    deny: ['Skill'],
    allow: policy.allow.filter((n) => isSafeSkillName(n)).map((n) => `Skill(${n})`)
  };
}
