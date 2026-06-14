// Pure allowlist + overlay merge for Claude Code settings.
// Spec: docs/superpowers/specs/2026-06-06-settings-inheritance-design.md

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The v1 allowlist is enforced by which mergers run in mergeSettings, not by
// consulting a constant — see §2 of the spec. The shape is: env (with reserved
// keys dropped), permissions.{allow,deny,ask} (concat+dedupe), enabledPlugins
// (shallow merge), extraKnownMarketplaces (shallow merge). Everything else
// from author layers is dropped.

export const RESERVED_ENV_PREFIXES = ['AGENT_MESH_'];
export const RESERVED_ENV_KEYS = [
  'PATH',
  'NODE_OPTIONS', 'NODE_PATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
];

export function isReservedEnvKey(key) {
  const upper = String(key).toUpperCase();
  if (RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return RESERVED_ENV_KEYS.includes(upper);
}

function mergeEnv(layers, overlayEnv) {
  const out = {};
  for (const layer of layers) {
    const env = layer?.env;
    if (!env || typeof env !== 'object') continue;
    for (const [k, v] of Object.entries(env)) {
      if (isReservedEnvKey(k)) continue;
      out[k] = v;
    }
  }
  if (overlayEnv) for (const [k, v] of Object.entries(overlayEnv)) out[k] = v;
  return out;
}

export const PERMISSION_ARRAY_FIELDS = ['allow', 'deny', 'ask'];

function mergePermissions(layers, overlayPerms) {
  const out = {};
  for (const field of PERMISSION_ARRAY_FIELDS) {
    const seen = new Set();
    const merged = [];
    for (const layer of layers) {
      const arr = layer?.permissions?.[field];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        const s = String(entry);
        if (seen.has(s)) continue;
        seen.add(s);
        merged.push(s);
      }
    }
    // Append overlay verbatim (no dedupe against overlay — overlay is trusted last-word).
    const oArr = overlayPerms?.[field];
    if (Array.isArray(oArr)) for (const entry of oArr) merged.push(String(entry));
    if (merged.length) out[field] = merged;
  }
  return out;
}

function shallowMergeMaps(layers, key) {
  const out = {};
  for (const layer of layers) {
    const m = layer?.[key];
    if (!m || typeof m !== 'object') continue;
    Object.assign(out, m);
  }
  return out;
}

export function mergeSettings(layers, overlay) {
  const result = {
    disableAllHooks: overlay?.disableAllHooks ?? false,
    hooks: overlay?.hooks ?? {},
    env: mergeEnv(layers, overlay?.env),
  };
  const permissions = mergePermissions(layers, overlay?.permissions);
  if (Object.keys(permissions).length) result.permissions = permissions;
  const enabledPlugins = shallowMergeMaps(layers, 'enabledPlugins');
  if (Object.keys(enabledPlugins).length) result.enabledPlugins = enabledPlugins;
  const extraKnownMarketplaces = shallowMergeMaps(layers, 'extraKnownMarketplaces');
  if (Object.keys(extraKnownMarketplaces).length) result.extraKnownMarketplaces = extraKnownMarketplaces;
  return result;
}

export async function readLayer(path) {
  try {
    const content = await readFile(path, 'utf8');
    try {
      return { ok: true, value: JSON.parse(content) };
    } catch (e) {
      return { ok: false, reason: 'malformed', message: e.message, path };
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing', path };
    return { ok: false, reason: 'io_error', message: e.message, path };
  }
}

export function resolveAuthorLayerPaths(root, claudeEnv) {
  const home = claudeEnv?.HOME;
  return {
    user: home ? join(home, '.claude', 'settings.json') : null,
    project: join(root, '.claude', 'settings.json'),
    local: join(root, '.claude', 'settings.local.json'),
  };
}
