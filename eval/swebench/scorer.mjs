// eval/swebench/scorer.mjs — score one SWE-bench task result.
// Phase 1 (ask_only): text keyword match — no Docker, no swebench CLI.
// Phase 2 (do_required): delegates to the external swebench CLI (not yet implemented).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Detect whether the `swebench` CLI is on PATH.
 * Returns true if found, false if not.
 */
export async function detectSwebench(bin = 'swebench') {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Score a Phase 1 (ask_only) task by text keyword matching.
 *
 * task: { expected_keywords?: string[], min_keyword_hits?: number }
 * answer: string — the agent's text response
 *
 * Returns { pass: boolean, hits: number, total: number, detail?: string }
 */
export function scoreTextMatch(task, answer) {
  const keywords = Array.isArray(task.expected_keywords) ? task.expected_keywords : [];
  const minHits = typeof task.min_keyword_hits === 'number' ? task.min_keyword_hits : 1;
  if (keywords.length === 0) {
    // No keywords to check — pass by default (task only tests that agent responds)
    return { pass: !!answer, hits: 0, total: 0, detail: 'no keywords defined; checking non-empty answer' };
  }
  const lc = answer.toLowerCase();
  const hits = keywords.filter((kw) => lc.includes(kw.toLowerCase())).length;
  const pass = hits >= minHits;
  return { pass, hits, total: keywords.length, detail: pass ? `${hits}/${keywords.length} keywords found` : `only ${hits}/${keywords.length} keywords found (need ${minHits})` };
}

/**
 * Score a Phase 2 (do_required) task via the swebench CLI.
 * Not yet implemented — returns a "skipped" result so Phase 1 runs can proceed.
 *
 * repoPath: local path to the worktree where the agent's patch was applied
 * task: the task descriptor
 * opts: { swebenchBin?: string }
 */
export async function scoreWithCli(_repoPath, _task, _opts = {}) {
  // Phase 2: implement after issue #97 (do-mode peer delegation) lands.
  // This stub lets the harness call scoreWithCli without crashing for Phase 1.
  return { pass: false, skipped: true, detail: 'do-mode scoring requires issue #97 (Phase 2)' };
}
