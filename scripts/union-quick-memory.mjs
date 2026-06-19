#!/usr/bin/env node
// scripts/union-quick-memory.mjs — resolve a conflicted `git merge origin/main` for a
// memory:promote PR, deterministically, in place. Used by dev-mesh-memory-automerge.yml.
//
// Resolves ONLY memory-data conflicts:
//   - dev-mesh/<role>/memory/quick.json        → keyed-JSON union (mergeQuickMemory)
//   - dev-mesh/<role>/memory/(<sub>/)?<name>.md → line-union (git merge-file --union)
// ANY other conflicted path → exit 3 (the workflow then aborts the merge and defers to
// mergefix). Never resolves code. Exit 0 only when every conflict was resolved + git-added.
// Spec: docs/superpowers/specs/2026-06-19-memory-automerge-union-design.md
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { mergeQuickMemory } from '../src/quick-memory-merge.js';
import { validateQuickMemory } from '../src/quick-memory.js';

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
const QUICK_RE = /^dev-mesh\/[^/]+\/memory\/quick\.json$/;
const MD_RE = /^dev-mesh\/[^/]+\/memory\/([^/]+\/)?[^/]+\.md$/;

/** Read a merge stage (1=base, 2=ours, 3=theirs); null when that stage is absent. */
function stage(n, path) {
  try { return git(['show', `:${n}:${path}`]); } catch { return null; }
}

function resolveQuickJson(path) {
  const ours = JSON.parse(stage(2, path) || '{}');
  const theirs = JSON.parse(stage(3, path) || '{}');
  const merged = mergeQuickMemory(ours, theirs);
  validateQuickMemory(merged);                       // fail-closed: throws → defer
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
  git(['add', '--', path]);
}

function resolveMarkdown(path) {
  const ours = stage(2, path), theirs = stage(3, path), base = stage(1, path);
  if (ours == null && theirs == null) throw new Error(`no content for ${path}`);
  if (base == null) {
    // add/add (no common ancestor for this file) → concatenate both sides.
    writeFileSync(path, [ours, theirs].filter((s) => s != null).join('\n'));
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'mq-'));
    try {
      const f = { o: join(dir, 'o'), b: join(dir, 'b'), t: join(dir, 't') };
      writeFileSync(f.o, ours ?? ''); writeFileSync(f.b, base); writeFileSync(f.t, theirs ?? '');
      // --union keeps BOTH sides of every conflict hunk; -p prints the result to stdout.
      const unioned = git(['merge-file', '-p', '--union', f.o, f.b, f.t]);
      writeFileSync(path, unioned);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  git(['add', '--', path]);
}

function main() {
  // core.quotePath=false: emit non-ASCII paths verbatim (not octal-escaped + quoted) so a
  // legitimately-named memory file isn't mis-classified as non-memory and needlessly deferred.
  const conflicted = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (conflicted.length === 0) { console.error('no conflicted files'); process.exit(3); }

  for (const path of conflicted) {
    if (QUICK_RE.test(path) && basename(path) === 'quick.json') {
      resolveQuickJson(path);
    } else if (MD_RE.test(path)) {
      resolveMarkdown(path);
    } else {
      console.error(`non-memory conflict (${path}) — deferring to mergefix`);
      process.exit(3);
    }
    console.error(`resolved ${path}`);
  }
}

try {
  main();
} catch (e) {
  console.error('union resolve failed:', e.message);
  process.exit(1);
}
