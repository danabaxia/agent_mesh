// Box-side: fetch the Mac digest over the tunnel, cache it, degrade to cache/[] offline.
export async function readInspiration({
  fetchImpl = fetch, url, token, ttlMs = 3_600_000, now = Date.now(),
  readCache = async () => null, writeCache = async () => {},
} = {}) {
  const cached = await readCache().catch(() => null);
  // Fresh cache (stamped within ttlMs) → serve without hitting the network.
  if (cached && typeof cached.fetchedAt === 'number' && (now - cached.fetchedAt) <= ttlMs && Array.isArray(cached.seeds)) {
    return { seeds: cached.seeds, generatedAt: cached.generatedAt ?? null, degraded: cached.degraded ?? [] };
  }
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res?.ok) throw new Error(`http ${res?.status}`);
    const body = await res.json();
    const digest = { seeds: Array.isArray(body?.seeds) ? body.seeds : [], generatedAt: body?.generatedAt ?? null, degraded: body?.degraded ?? [] };
    await writeCache({ ...digest, fetchedAt: now }).catch(() => {});
    return digest;
  } catch {
    if (cached && Array.isArray(cached.seeds)) return { seeds: cached.seeds, generatedAt: cached.generatedAt ?? null, degraded: cached.degraded ?? [] };
    return { seeds: [], generatedAt: null, degraded: [] };
  }
}
