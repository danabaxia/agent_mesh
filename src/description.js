import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MAX_DESCRIPTION_CHARS } from './config.js';

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
    return `${name}: no AGENT.md found. Delegate only after confirming this folder owns the task.`;
  }

  return boundDescription(text);
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
