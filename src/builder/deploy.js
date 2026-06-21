// src/builder/deploy.js — one-click mesh deploy.
//
// Chains the three safe primitives — discover → add → doctor — into a single
// command so an operator can stand up (or extend) a mesh from a local checkout
// without hand-enumerating every agent folder. PROJECT.md's deployment promise:
// "one-click generate and recognize local agents, and join them by project need."
//
// SAFETY: this is a thin orchestrator. It performs NO new kind of mutation — every
// write goes through `add`/`doctor`/`initMesh`, which keep their own dry-run-by-
// default semantics and managed-wiring guards. Dry-run (the default) writes
// nothing and returns the plan. A folder already in the manifest is skipped; a
// folder physically under the mesh root is reported for `join` (not copied into
// itself). One agent's `add` failing never aborts the others — failure is data.
import { resolve, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { discoverAgentCandidates } from './discover.js';
import { add } from './add.js';
import { doctor } from './doctor.js';
import { initMesh } from './init-mesh.js';
import { readManifest } from './manifest.js';

// Agent names already registered in the mesh, for name-keyed idempotency. `add`
// copies a source folder to a DEST inside the mesh and keys the manifest by name,
// so re-deploying the same source must dedup by name (its dest path differs from
// the source the path-based discovery annotation sees). Best-effort: a missing
// manifest → empty set.
async function manifestNames(meshRoot) {
  try { return new Set((await readManifest(meshRoot)).agents?.map((a) => a.name) ?? []); }
  catch { return new Set(); }
}

const isUnder = (child, parent) => child === parent || child.startsWith(parent + sep);

/**
 * Discover agent folders under `scanRoot` and wire the new ones into the mesh at
 * `meshRoot` (creating the mesh substrate if absent), then run doctor to sync
 * registries/bridges/hooks.
 *
 * @param {string}   scanRoot                folder to scan for agent candidates.
 * @param {object}   opts
 * @param {string}   opts.meshRoot           mesh root to build/extend (required).
 * @param {boolean}  [opts.apply=false]      false = plan only, write nothing.
 * @param {string[]} [opts.modes=['ask']]    enabledModes for newly-added agents.
 * @param {number}   [opts.maxDepth=4]       discovery walk depth.
 * @returns {Promise<object>} a structured plan/outcome report (never throws on a
 *          per-agent failure; aggregates errors instead).
 */
export async function deployMesh(scanRoot, { meshRoot, apply = false, modes = ['ask'], maxDepth = 4 } = {}) {
  const scan = resolve(scanRoot);
  const mesh = resolve(meshRoot);
  const out = {
    meshRoot: mesh, dryRun: !apply, initialized: false,
    added: [], skippedInTree: [], alreadyInMesh: [], errors: [], doctor: null,
  };

  // 1. Ensure the mesh substrate exists (so add() can read the manifest).
  let meshReady = existsSync(join(mesh, 'mesh.json'));
  if (!meshReady) {
    if (apply) { await mkdir(mesh, { recursive: true }); await initMesh(mesh); out.initialized = true; meshReady = true; }
    else { out.initialized = 'would-init'; }
  }

  // 2. Discover candidates, annotated against the mesh when one exists.
  const candidates = await discoverAgentCandidates(scan, { meshRoot: mesh, maxDepth });
  const names = meshReady ? await manifestNames(mesh) : new Set();

  // 3. Add each new, out-of-tree candidate.
  for (const c of candidates) {
    // Already in the mesh — by registered name (re-deploy of the same source) or
    // by path (the scan root IS the mesh, so the folder is its own dest).
    if (names.has(c.name) || c.alreadyInMesh) { out.alreadyInMesh.push(c.name); continue; }
    if (isUnder(c.path, mesh)) { out.skippedInTree.push({ name: c.name, path: c.path }); continue; }
    if (!meshReady) {            // dry-run on a not-yet-created mesh: plan only.
      out.added.push({ name: c.name, dest: '(pending mesh init)', planned: true });
      continue;
    }
    try {
      const r = await add(mesh, c.path, { modes, apply });
      const addedName = r.manifestEntry?.name ?? c.name;
      names.add(addedName);   // dedup later same-name candidates in this run
      out.added.push({ name: addedName, dest: r.dest, planned: !apply });
    } catch (e) {
      out.errors.push({ stage: 'add', name: c.name, error: e.message });
    }
  }

  // 4. Sync wiring (registries/bridges/hooks) when the mesh is real.
  if (meshReady) {
    try { out.doctor = await doctor(mesh, { apply }); }
    catch (e) { out.errors.push({ stage: 'doctor', error: e.message }); }
  }

  return out;
}
