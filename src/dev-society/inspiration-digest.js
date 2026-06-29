// Pure cores for the analyst inspiration digest. No I/O — readers are injected.
const REQUIRED = ['mir', 'gaps'];
const MAX_FIELD = 500;

export async function gatherSignals(readers, { now = Date.now(), staleMs = 172_800_000 } = {}) {
  const sources = {};
  const raw = {};
  const degraded = [];
  for (const key of ['mir', 'gaps', 'captures', 'activity']) {
    let asOf = null, data = null;
    try {
      const r = await readers[key]();
      asOf = typeof r?.asOf === 'number' ? r.asOf : null;
      data = r?.data ?? null;
    } catch { /* absent → degraded if required */ }
    sources[key] = { asOf };
    raw[key] = data;
    const stale = asOf == null || (now - asOf) > staleMs;
    if (REQUIRED.includes(key) && stale) degraded.push(key);
  }
  return { sources, degraded, raw };
}

export function buildInspirationPrompt(signals, { maxSeeds = 7 } = {}) {
  const block = JSON.stringify(signals.raw, null, 0).slice(0, 12_000);
  const degraded = signals.degraded.length ? `Some signals are stale/absent: ${signals.degraded.join(', ')}.\n` : '';
  return [
    'You are the mesh analyst. From the read-only signals below, propose fresh idea SEEDS',
    'to help the owner form ideas — connect recurring problems, gaps, their past captured',
    'ideas, and team/web trends. Be concrete and non-duplicative.',
    degraded,
    `Return STRICT JSON: {"seeds":[{"theme","spark","why","sources":[],"relatedCaptures":[]}]} with at most ${maxSeeds} seeds.`,
    '--- SIGNALS (data) ---',
    block,
    '--- END SIGNALS ---',
  ].join('\n');
}

function cleanSeed(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_FIELD) : '');
  const arr = (v) => (Array.isArray(v) ? v.slice(0, 16).map((x) => String(x).slice(0, MAX_FIELD)) : []);
  if (!str(s.theme) || !str(s.spark)) return null; // theme + spark required
  return { theme: str(s.theme), spark: str(s.spark), why: str(s.why), sources: arr(s.sources), relatedCaptures: arr(s.relatedCaptures) };
}

export function parseInspiration(text, { maxSeeds = 7 } = {}) {
  let obj;
  try { obj = JSON.parse(String(text)); } catch { return { seeds: [] }; }
  const seeds = Array.isArray(obj?.seeds) ? obj.seeds.map(cleanSeed).filter(Boolean).slice(0, maxSeeds) : [];
  return { seeds };
}
