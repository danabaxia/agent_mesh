import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { MAX_DESCRIPTION_CHARS } from './config.js';

// AGENT.md shorter than this is treated as absent; auto-fingerprint fills in.
const AGENT_MD_MIN_CHARS = 80;

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
  let text;
  try {
    text = await readFile(join(root, 'AGENT.md'), 'utf8');
  } catch {
    // AGENT.md absent — fall through to auto-fingerprint
  }

  if (text && text.trim().length >= AGENT_MD_MIN_CHARS) {
    return boundDescription(text);
  }

  return harvestFingerprint(root, name);
}

async function harvestFingerprint(root, name) {
  const parts = [`[auto] name: ${name}`];

  // Read package.json for description and entry point
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.description) parts.push(pkg.description);
    const entry = pkg.main || pkg.exports?.['.']; // string-only; skip complex export maps
    if (entry && typeof entry === 'string') parts.push(`entry: ${entry}`);
  } catch {
    // No package.json or parse error — skip
  }

  // Top-level directory listing: dirs + file-extension counts
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .slice(0, 10);
    if (dirs.length > 0) parts.push(`dirs: ${dirs.join(',')}`);

    const extCounts = {};
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = extname(e.name);
      if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }
    const extSummary = Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, n]) => `${ext}:${n}`)
      .join(',');
    if (extSummary) parts.push(extSummary);
  } catch {
    // readdir failure — skip dir/ext info
  }

  return boundDescription(parts.join(' · '));
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
