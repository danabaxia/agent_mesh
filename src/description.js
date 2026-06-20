import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { MAX_DESCRIPTION_CHARS, MIN_AGENT_MD_CHARS } from './config.js';

// Compactness caps for the auto fingerprint so it stays a routing hint, not a
// full listing (MAX_DESCRIPTION_CHARS is the hard cap; these keep it tidy first).
const MAX_FINGERPRINT_DIRS = 12;
const MAX_FINGERPRINT_EXTS = 6;
// Top-level dirs that are pure noise for routing — never describe what a peer owns.
const FINGERPRINT_SKIP_DIRS = new Set(['node_modules']);

export async function describeFolder(root) {
  const name = basename(root);
  const description = await readAgentDescription(root, name);
  return {
    name,
    root,
    description,
    capabilities: extractCapabilities(description)
  };
}

export async function readAgentDescription(root, name = basename(root)) {
  // Human-authored AGENT.md takes unconditional precedence WHEN ADEQUATE. A thin
  // (< MIN_AGENT_MD_CHARS) or absent AGENT.md is a routing dead-end, so we harvest
  // a compact `[auto]` fingerprint (package.json + top-level dir listing) instead
  // of the old "no AGENT.md found" note (issue #184). The fingerprint reads only
  // within `root`, adds no runtime deps, and is bounded like any other description.
  let human = null;
  try {
    human = boundDescription(await readFile(join(root, 'AGENT.md'), 'utf8'));
  } catch {
    human = null;
  }
  if (human && human.length >= MIN_AGENT_MD_CHARS) return human;

  const fingerprint = await autoFingerprint(root, name);
  // A present-but-thin AGENT.md is supplemented, not discarded: keep the human
  // text and append the fingerprint so no authored content is ever lost.
  if (human) return boundDescription(`${human} ${fingerprint}`);
  return fingerprint;
}

// Auto-harvested peer fingerprint (issue #184), modeled on Aider's repo-map: a
// fresh compact index beats stale/missing docs for LLM routing. Pure node:fs,
// one top-level read of `root`. Never throws — every part degrades to absent.
// Shape: `[auto] name: my-lib · A validator · entry: src/index.js · dirs: src,test · .js:34,.md:3`
async function autoFingerprint(root, name) {
  const parts = [];
  const pkg = await readPackageJson(root);
  parts.push(`name: ${typeof pkg.name === 'string' && pkg.name ? pkg.name : name}`);
  if (typeof pkg.description === 'string' && pkg.description.trim()) {
    parts.push(pkg.description.trim());
  }
  const entry = packageEntry(pkg);
  if (entry) parts.push(`entry: ${entry}`);

  const { dirs, extCounts } = await listTopLevel(root);
  if (dirs.length) parts.push(`dirs: ${dirs.slice(0, MAX_FINGERPRINT_DIRS).join(',')}`);
  if (extCounts) parts.push(extCounts);

  return boundDescription(`[auto] ${parts.join(' · ')}`);
}

async function readPackageJson(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' ? pkg : {};
  } catch {
    return {};
  }
}

// `main`, else the first `bin` target (string form or first object value).
function packageEntry(pkg) {
  if (typeof pkg.main === 'string' && pkg.main) return pkg.main;
  const { bin } = pkg;
  if (typeof bin === 'string' && bin) return bin;
  if (bin && typeof bin === 'object') {
    const first = Object.values(bin).find((v) => typeof v === 'string' && v);
    if (first) return first;
  }
  return null;
}

// One non-recursive listing of `root`: sorted visible dirs (noise excluded) plus
// a by-frequency extension histogram of visible top-level files.
async function listTopLevel(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { dirs: [], extCounts: '' };
  }
  const dirs = [];
  const extCount = new Map();
  for (const entry of entries) {
    const entryName = entry.name;
    if (entryName.startsWith('.')) continue; // hidden files/dirs (.git, dotfiles)
    if (entry.isDirectory()) {
      if (!FINGERPRINT_SKIP_DIRS.has(entryName)) dirs.push(entryName);
    } else if (entry.isFile()) {
      const ext = extname(entryName);
      if (ext) extCount.set(ext, (extCount.get(ext) || 0) + 1);
    }
  }
  dirs.sort();
  const extCounts = [...extCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_FINGERPRINT_EXTS)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(',');
  return { dirs, extCounts };
}

export function boundDescription(text, limit = MAX_DESCRIPTION_CHARS) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 15)).trimEnd()}... [truncated]`;
}

export function extractCapabilities(description) {
  const match = description.match(/capabilities\s*:\s*([^.;]+)/i);
  if (!match) return undefined;
  return match[1]
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}
