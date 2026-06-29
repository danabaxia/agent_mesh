// Box-side: fetch the Mac digest over the tunnel, cache it, degrade to cache/[] offline.
export async function readInspiration({
  fetchImpl = fetch, url, token, ttlMs = 3_600_000, now = Date.now(),
  readCache = async () => null, writeCache = async () => {},
} = {}) {
  const cached = await readCache().catch(() => null);
  // (TTL check left to the caller's cache file mtime; here cached is the parsed digest.)
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res?.ok) throw new Error(`http ${res?.status}`);
    const body = await res.json();
    const digest = { seeds: Array.isArray(body?.seeds) ? body.seeds : [], generatedAt: body?.generatedAt ?? null, degraded: body?.degraded ?? [] };
    await writeCache(digest).catch(() => {});
    return digest;
  } catch {
    if (cached && Array.isArray(cached.seeds)) return { seeds: cached.seeds, generatedAt: cached.generatedAt ?? null, degraded: cached.degraded ?? [] };
    return { seeds: [], generatedAt: null, degraded: [] };
  }
}
