/**
 * src/builder/migrate.js
 *
 * Copy/migration policy for onboarding an agent folder into the mesh.
 * v1: copy-only (no --move). The original is never modified.
 *
 * Two-tier ignore:
 *  1. Non-overridable safety denylist — never copied, no flag, no exception.
 *  2. .gitignore tier — skipped by default; opts.includeIgnored re-includes
 *     these (but CANNOT reach the denylist).
 *
 * Symlinks: skipped-with-warning by default; opts.copySymlinks opts in, but
 * only preserves a link if its realpath is inside srcDir. Never followed.
 *
 * Collision: throws if destDir is non-empty and !opts.force.
 *
 * Returns { copied: string[], skipped: string[] } — paths relative to srcDir.
 */

import {
  readdir, stat, lstat, copyFile, mkdir, readFile, symlink, realpath
} from 'node:fs/promises';
import { join, relative, dirname, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Safety denylist — never copied
// ---------------------------------------------------------------------------

// Top-level directory names (exact)
const DENY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out']);

// Filename / glob-like predicates (applied to basename)
function isDeniedFile(name) {
  // .env* (including .env, .env.local, .env.production, etc.)
  if (name === '.env' || name.startsWith('.env.') || name.startsWith('.env_')) return true;
  // *.pem
  if (name.endsWith('.pem')) return true;
  // *.key
  if (name.endsWith('.key')) return true;
  // id_rsa* (covers id_rsa, id_rsa.pub, id_rsa_something)
  if (name === 'id_rsa' || name.startsWith('id_rsa.') || name.startsWith('id_rsa_')) return true;
  // *secret* (case-insensitive)
  if (name.toLowerCase().includes('secret')) return true;
  // *credential* (case-insensitive)
  if (name.toLowerCase().includes('credential')) return true;
  // .DS_Store
  if (name === '.DS_Store') return true;
  return false;
}

function isDeniedDir(name) {
  return DENY_DIRS.has(name);
}

// ---------------------------------------------------------------------------
// .gitignore parser — minimal, top-level patterns only
// ---------------------------------------------------------------------------

async function loadGitignorePatterns(srcDir) {
  const gitignorePath = join(srcDir, '.gitignore');
  try {
    const text = await readFile(gitignorePath, 'utf8');
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Very simple gitignore matcher for top-level paths.
 * Supports patterns like: logs/, *.log, temp
 * Does NOT support negation (!) or complex glob patterns.
 */
function matchesGitignore(patterns, relPath) {
  // relPath is relative to src root
  const name = basename(relPath);
  const parts = relPath.split('/');
  const topLevel = parts[0];

  for (const pattern of patterns) {
    // Strip trailing slash (directory marker)
    const stripped = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    // Skip negation patterns — not supported in v1
    if (stripped.startsWith('!')) continue;

    // Exact match on name
    if (stripped === name) return true;
    // Exact match on top-level segment
    if (stripped === topLevel) return true;
    // Simple wildcard: *.ext
    if (stripped.startsWith('*') && !stripped.includes('/')) {
      const ext = stripped.slice(1); // e.g. '.log'
      if (name.endsWith(ext)) return true;
    }
    // Pattern with / — match as prefix
    if (stripped.includes('/')) {
      if (relPath === stripped || relPath.startsWith(stripped + '/')) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Collision check
// ---------------------------------------------------------------------------

async function isNonEmptyDir(dir) {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Copy srcDir into destDir under the migration policy.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {object} opts
 *   @param {boolean} [opts.force]          — allow non-empty destDir
 *   @param {boolean} [opts.includeIgnored] — re-include .gitignore-listed paths
 *   @param {boolean} [opts.copySymlinks]   — preserve in-tree symlinks
 * @returns {Promise<{ copied: string[], skipped: string[] }>}
 */
export async function copyInto(srcDir, destDir, opts = {}) {
  const { force = false, includeIgnored = false, copySymlinks = false } = opts;

  // Collision check
  if (!force && await isNonEmptyDir(destDir)) {
    throw new Error(
      `Destination "${destDir}" is non-empty. Pass opts.force to overwrite (collision).`
    );
  }

  const gitignorePatterns = includeIgnored ? [] : await loadGitignorePatterns(srcDir);

  const copied = [];
  const skipped = [];

  await walkAndCopy(srcDir, srcDir, destDir, {
    copySymlinks,
    includeIgnored,
    gitignorePatterns,
    copied,
    skipped
  });

  return { copied, skipped };
}

// ---------------------------------------------------------------------------
// Recursive walker
// ---------------------------------------------------------------------------

async function walkAndCopy(srcRoot, currentDir, destDir, state) {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const srcPath = join(currentDir, entry.name);
    const relPath = relative(srcRoot, srcPath).split('\\').join('/'); // normalize on Windows too
    const destPath = join(destDir, relPath);

    // -----------------------------------------------------------------------
    // Safety denylist checks (applied regardless of type)
    // -----------------------------------------------------------------------

    // Check the top-level segment for denied directories
    const topSegment = relPath.split('/')[0];
    if (isDeniedDir(topSegment)) {
      state.skipped.push(relPath);
      continue;
    }

    // Denied file patterns (apply to the name)
    if (isDeniedFile(entry.name)) {
      state.skipped.push(relPath);
      continue;
    }

    // -----------------------------------------------------------------------
    // .gitignore tier (skipped unless opts.includeIgnored)
    // -----------------------------------------------------------------------
    if (!state.includeIgnored && state.gitignorePatterns.length > 0) {
      if (matchesGitignore(state.gitignorePatterns, relPath)) {
        state.skipped.push(relPath);
        continue;
      }
    }

    // -----------------------------------------------------------------------
    // Symlink handling
    // -----------------------------------------------------------------------
    let lstats;
    try {
      lstats = await lstat(srcPath);
    } catch {
      state.skipped.push(relPath);
      continue;
    }

    if (lstats.isSymbolicLink()) {
      if (!state.copySymlinks) {
        // Default: skip with warning
        state.skipped.push(relPath);
        continue;
      }
      // --copy-symlinks: preserve only if realpath is inside srcRoot
      let resolved;
      try {
        resolved = await realpath(srcPath);
      } catch {
        // Unresolvable link — skip
        state.skipped.push(relPath);
        continue;
      }
      const relResolved = relative(srcRoot, resolved);
      if (relResolved.startsWith('..') || relResolved === '..') {
        // Out-of-tree — skip
        state.skipped.push(relPath);
        continue;
      }
      // In-tree symlink: read original link target and preserve as symlink
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(srcPath);
      await mkdir(dirname(destPath), { recursive: true });
      try {
        await symlink(target, destPath);
        state.copied.push(relPath);
      } catch {
        state.skipped.push(relPath);
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Directory
    // -----------------------------------------------------------------------
    if (entry.isDirectory()) {
      // Recurse — the directory name has already passed denylist above
      await walkAndCopy(srcRoot, srcPath, destDir, state);
      continue;
    }

    // -----------------------------------------------------------------------
    // Regular file
    // -----------------------------------------------------------------------
    if (entry.isFile()) {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      state.copied.push(relPath);
    }
  }
}
