import { createBridge } from '../a2a/peer-bridge.js';
import { dirname } from 'node:path';

const TOOL_TIMEOUT_MS = 20_000;

/**
 * Build a file-backed readCache/writeCache pair for readInspiration.
 * Uses atomic write (tmp + rename) to avoid partial reads.
 */
export function fileCache(cacheFile, { readFile, writeFile, mkdir, rename, randomUUID }) {
  return {
    readCache: async () => { try { return JSON.parse(await readFile(cacheFile, 'utf8')); } catch { return null; } },
    writeCache: async (digest) => {
      await mkdir(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(digest));
      await rename(tmp, cacheFile);
    },
  };
}

const SPECS = [
  { name: 'mesh_status', description: 'Live mesh status: open issue/PR counts and headline items.', parameters: { type: 'object', properties: {} } },
  { name: 'list_mesh_agents', description: 'List the agents registered in the mesh.', parameters: { type: 'object', properties: {} } },
  { name: 'ask_peer', description: 'Ask one named mesh agent a question and get its answer.',
    parameters: { type: 'object', properties: { agent: { type: 'string' }, question: { type: 'string' } }, required: ['agent', 'question'] } },
  { name: 'propose_idea', description: 'Capture the user\'s idea as a structured proposal (records it; does not file anything).',
    parameters: { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' } }, required: ['title'] } },
  { name: 'brainstorm_seeds', description: 'Get fresh idea seeds drawn from the mesh — recurring problems, gaps, your past ideas, trends — to spark a new idea or develop one you are forming.',
    parameters: { type: 'object', properties: { topic: { type: 'string' } } } },
];

function withTimeout(promise, ms, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish({ error: 'tool_timeout' }), ms);
    if (signal) signal.addEventListener('abort', () => finish({ error: 'aborted' }), { once: true });
    Promise.resolve(promise).then((v) => { clearTimeout(timer); finish(v); },
      (e) => { clearTimeout(timer); finish({ error: String(e?.message || e) }); });
  });
}

/**
 * Build the concierge's ask-only tool surface.
 * `deps` are injectable; defaults wire the real read backends + peer bridge.
 */
export function buildToolAdapters({ root, env = {}, callEnv = {}, deps = {} } = {}) {
  const askPeer = deps.askPeer || (async ({ agent, question }) => {
    // createBridge({root, env}) returns the bridge object; delegate_to_peer is a
    // closure over (root, env). It enforces ask-only + marker-validated registry +
    // recursion/cost propagation. Failures come back as DATA, never thrown.
    const bridge = createBridge({ root, env: { ...env, ...callEnv } });
    const r = await bridge.delegateToPeer({ peer: agent, mode: 'ask', task: question });
    return { answer: r?.summary ?? '', status: r?.status, ok: r?.ok };
  });
  const meshStatus = deps.meshStatus || (async () => ({ error: 'mesh_status backend not wired' }));
  const listAgents = deps.listAgents || (async () => {
    // Default backend: the SAME marker-validated registry ask_peer uses, so the
    // concierge can actually enumerate its peers. Without this it returned [],
    // making the brain report "no agents registered" even though ask_peer could
    // reach them. Failures degrade to [] (never throw the loop).
    try {
      const bridge = createBridge({ root, env: { ...env, ...callEnv } });
      return await bridge.listPeers();
    } catch {
      return [];
    }
  });
  const brainstorm = deps.brainstorm || (async ({ topic } = {}) => {
    try {
      const { readInspiration } = await import('./inspiration-reader.js');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const fsp = await import('node:fs/promises');
      const { randomUUID } = await import('node:crypto');
      const url = process.env.INSPIRATION_URL || (process.env.MAC_CAPTURE_URL || '').replace(/\/capture\b.*$/, '/inspiration');
      const cacheFile = process.env.AGENT_MESH_INSPIRATION_CACHE || join(homedir(), '.agent-mesh', 'inspiration-cache.json');
      const ttlMs = Number(process.env.INSPIRATION_CACHE_TTL_MS) || 3_600_000;
      const { readCache, writeCache } = fileCache(cacheFile, { readFile: fsp.readFile, writeFile: fsp.writeFile, mkdir: fsp.mkdir, rename: fsp.rename, randomUUID });
      const d = await readInspiration({ url, token: process.env.MAC_INSPIRATION_TOKEN, ttlMs, readCache, writeCache });
      const seeds = topic ? (d.seeds || []).filter((s) => `${s.theme} ${s.spark}`.toLowerCase().includes(String(topic).toLowerCase())) : (d.seeds || []);
      return { seeds, generatedAt: d.generatedAt ?? null, degraded: d.degraded ?? [] };
    } catch { return { seeds: [] }; }
  });

  async function run(name, args) {
    switch (name) {
      case 'propose_idea': {
        const title = String(args?.title ?? '').trim();
        if (!title) return { error: 'title_required' };
        const idea = { title, note: String(args?.note ?? '') };
        return { ok: true, __enrichment: { idea } }; // NO write — enrichment only
      }
      case 'ask_peer':
        return askPeer({ agent: String(args?.agent ?? ''), question: String(args?.question ?? '') });
      case 'mesh_status':
        return meshStatus();
      case 'list_mesh_agents':
        return { agents: await listAgents() };
      case 'brainstorm_seeds':
        return brainstorm({ topic: args?.topic != null ? String(args.topic) : undefined }).catch(() => ({ seeds: [] }));
      default:
        return { error: 'unknown_tool' };
    }
  }

  return {
    specs: SPECS,
    dispatch: (name, args, { signal } = {}) => withTimeout(run(name, args), TOOL_TIMEOUT_MS, signal),
  };
}
