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
    // The analyst replies in markdown by default; ask for a fenced block and extract it
    // (same convention as analyst-ideas, which the analyst reliably follows).
    `Emit your seeds as a SINGLE fenced \`\`\`json block containing {"seeds":[{"theme","spark","why","sources":[],"relatedCaptures":[]}]} with at most ${maxSeeds} seeds.`,
    'Output ONLY that fenced ```json block — no prose, no tables, no preamble.',
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
  const raw = String(text ?? '');
  // The real analyst wraps its JSON in a fenced ```json block (and may surround it with
  // prose/tables); extract the LAST such block. Fall back to the whole string so clean-JSON
  // callers/tests still work. Tolerant: anything unparseable → { seeds: [] }.
  const blocks = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = blocks.length ? blocks[blocks.length - 1][1].trim() : raw;
  let obj;
  try { obj = JSON.parse(candidate); } catch { return { seeds: [] }; }
  const seeds = Array.isArray(obj?.seeds) ? obj.seeds.map(cleanSeed).filter(Boolean).slice(0, maxSeeds) : [];
  return { seeds };
}
