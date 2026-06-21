// Pure freshness/staleness helpers — no DOM, no Date.now(); time is injected.
export function isStale(lastUpdateAt, now, thresholdMs) {
  if (lastUpdateAt == null) return true;
  return now - lastUpdateAt >= thresholdMs;
}
export function backoffDelays(baseMs, maxMs, attempts) {
  const out = [];
  for (let i = 0; i < attempts; i++) out.push(Math.min(maxMs, baseMs * 2 ** i));
  return out;
}
