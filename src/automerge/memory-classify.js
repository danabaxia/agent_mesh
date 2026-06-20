// Pure read-only pre-check for a memory:promote PR. Mirrors the workflow's static
// guards (same-repo · memory-paths-only · current quick.json valid). NOT the live
// merge: returns `merge-candidate`, never `would-merge`.
import { validateQuickMemory } from '../quick-memory.js';

const MEMORY_PATH = /^dev-mesh\/[^/]+\/memory\/(quick\.json|([^/]+\/)?[^/]+\.md)$/;

/**
 * @param {{number:number, isCrossRepository?:boolean, files:string[], quickJsonContents:string[]}} pr
 * @returns {{state:'merge-candidate'|'needs-human', reason:string|null}}
 */
export function classifyMemoryPr(pr) {
  if (!pr || pr.isCrossRepository !== false) return { state: 'needs-human', reason: 'fork' };
  const files = Array.isArray(pr.files) ? pr.files : [];
  if (files.length === 0 || !files.every((f) => MEMORY_PATH.test(f))) return { state: 'needs-human', reason: 'non-memory-path' };
  for (const raw of (pr.quickJsonContents || [])) {
    try { validateQuickMemory(JSON.parse(raw)); }
    catch { return { state: 'needs-human', reason: 'invalid-quick-json' }; }
  }
  return { state: 'merge-candidate', reason: null };
}
