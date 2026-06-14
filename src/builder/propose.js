/**
 * src/builder/propose.js
 *
 * Proposed-patch helpers (§5.3).
 *
 * When an existing Seeded file is present but missing required fields, the
 * tool must NOT edit it in place. Instead it writes a `*.proposed` file
 * alongside the live file, leaving the original untouched.
 *
 * Purity split:
 *   buildProposedContent()  — pure helper (exported for testing)
 *   proposePatch()          — thin I/O (writes the proposed file)
 */

import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

/**
 * Return the path the proposed file will be written to.
 * Naming convention: <original-path>.proposed
 *
 * @param {string} path  absolute or relative path to the original file
 * @returns {string}
 */
export function proposedPath(path) {
  return path + '.proposed';
}

// ---------------------------------------------------------------------------
// Public API — thin I/O
// ---------------------------------------------------------------------------

/**
 * Write a proposed-patch file at `<path>.proposed` without touching `<path>`.
 *
 * @param {string} path     absolute path to the original (live) file
 * @param {string} content  content of the proposal
 * @returns {Promise<string>}  the absolute path of the written proposed file
 */
export async function proposePatch(path, content) {
  const dest = proposedPath(path);
  await writeFile(dest, content, 'utf8');
  return dest;
}
