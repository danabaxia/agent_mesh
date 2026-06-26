import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

export async function readRegistry(path) {
  const base = resolve(path);
  const parsed = JSON.parse(await readFile(base, 'utf8'));
  return normalizeRegistry(parsed, base);
}

/**
 * Strict reader for the peer bridge: only a MANAGED registry.json — one carrying
 * the `x-agentmesh-generated:true` marker AND a `peers` object — yields peers.
 * `normalizeRegistry` deliberately accepts markerless/bare maps (hand-authored
 * caller registries); the bridge must NOT, so a tampered/markerless registry can
 * never become a spawn source ("registry is the only peer source").
 *
 * @param {string} root  agent root containing registry.json
 * @returns {Promise<{ ok: boolean, reason: string|null, registry: { peers: object } }>}
 */
export async function readManagedRegistry(root) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'));
  } catch {
    return { ok: false, reason: 'absent', registry: { peers: {} } };
  }
  const marked = parsed?.['x-agentmesh-generated'] === true;
  const peers = parsed?.peers;
  const peersOk = peers && typeof peers === 'object' && !Array.isArray(peers);
  if (!marked || !peersOk) {
    return { ok: false, reason: 'stale_registry', registry: { peers: {} } };
  }
  return { ok: true, reason: null, registry: { peers } };
}

export async function normalizeRegistry(registry, sourcePath = process.cwd()) {
  const peers = registry?.peers || registry;
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) {
    throw new Error('registry must be an object or { "peers": { ... } }.');
  }

  const normalized = {};
  for (const [name, peer] of Object.entries(peers)) {
    normalized[name] = await normalizePeer(name, peer, sourcePath);
  }
  return normalized;
}

async function normalizePeer(name, peer, sourcePath) {
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) {
    throw new Error(`registry peer "${name}" must be an object.`);
  }

  // HTTP peer: declared via a `url` field (no spawn command needed).
  const url = peer.url;
  if (typeof url === 'string' && url.length > 0) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`registry peer "${name}" url must begin with http:// or https://.`);
    }
    const env = peer.env && typeof peer.env === 'object' && !Array.isArray(peer.env) ? peer.env : {};
    return { type: 'http', name, url, env };
  }

  // Stdio peer: declared via a spawn command.
  const spawn = peer.spawn || peer;
  const command = spawn.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(`registry peer "${name}" requires either a url (HTTP peer) or a spawn command (stdio peer).`);
  }

  const args = Array.isArray(spawn.args) ? spawn.args.map(String) : [];
  const root = peer.root ? await realpath(resolveRelative(sourcePath, peer.root)) : null;
  const env = peer.env && typeof peer.env === 'object' && !Array.isArray(peer.env) ? peer.env : {};

  const normalized = { type: 'stdio', name, root, command, args, env };
  if (peer.thinking_effort !== undefined) normalized.thinking_effort = peer.thinking_effort;
  return normalized;
}

function resolveRelative(sourcePath, path) {
  if (path.startsWith('/')) return path;
  return resolve(sourcePath.endsWith('.json') ? dirname(sourcePath) : sourcePath, path);
}
