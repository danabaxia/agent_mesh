import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, relative } from 'node:path';

// Normalize backslashes to forward slashes so comparisons work on Windows and
// POSIX identically — Windows paths from realpath/relative use \, while callers
// (and test assertions) may supply / or \.
function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

export async function isPathInsideRoot(root, candidate) {
  const canonicalRoot = await realpath(root);
  const normalizedCandidate = toForwardSlash(candidate);
  const absoluteCandidate = isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : resolve(canonicalRoot, normalizedCandidate);
  const canonicalCandidate = await canonicalizePossiblyMissing(absoluteCandidate);
  const rel = toForwardSlash(relative(canonicalRoot, canonicalCandidate));
  return rel === '' || (!rel.startsWith('..') && rel !== '..' && !rel.includes('../') && !isAbsolute(rel));
}

// Boundary 5 (PROJECT.md): an agent's trusted configuration. A normal delegated
// `do` task may write runtime/state and task-owned work, but NOT these — that
// would let a delegated task silently rewrite the agent's future identity, tool
// grants, peer wiring, or obeyed memory/workflows. Self-modifying config is a
// separate admin workflow, not part of normal delegation.
const PROTECTED_CONFIG_FILES = new Set(['agent.json', '.mcp.json', 'registry.json']);
const PROTECTED_CONFIG_DIRS = new Set(['prompts', 'tools', 'memory', 'workflows', 'skills', '.claude']);

// True when `candidate` resolves to protected config INSIDE `root`. Paths
// outside the root (or the root itself) return false — the inside-root check is
// a separate concern handled by isPathInsideRoot. Canonicalizes symlinks and
// missing segments exactly like isPathInsideRoot, so the boundary cannot be
// dodged via a symlink or a not-yet-created path.
export async function isProtectedConfigPath(root, candidate) {
  const canonicalRoot = await realpath(root);
  const normalizedCandidate = toForwardSlash(candidate);
  const absoluteCandidate = isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : resolve(canonicalRoot, normalizedCandidate);
  const canonicalCandidate = await canonicalizePossiblyMissing(absoluteCandidate);
  const rel = toForwardSlash(relative(canonicalRoot, canonicalCandidate));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const segments = rel.split('/');
  const top = segments[0];
  if (segments.length === 1) {
    return PROTECTED_CONFIG_FILES.has(top) || PROTECTED_CONFIG_DIRS.has(top);
  }
  return PROTECTED_CONFIG_DIRS.has(top);
}

export async function canonicalizePossiblyMissing(path) {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    const canonicalParent = await canonicalizePossiblyMissing(parent);
    return resolve(canonicalParent, basename(path));
  }
}

export function extractToolPaths(toolName, input) {
  if (!input || typeof input !== 'object') return [];

  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return typeof input.file_path === 'string' ? [input.file_path] : [];
    // NotebookEdit's path argument is `notebook_path`, not `file_path`.
    case 'NotebookEdit':
      return typeof input.notebook_path === 'string' ? [input.notebook_path] : [];
    default:
      return [];
  }
}
