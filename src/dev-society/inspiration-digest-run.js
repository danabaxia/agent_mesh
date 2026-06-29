// Impure shell: gather injected signals → ask the analyst → atomically write the digest.
import { gatherSignals, buildInspirationPrompt, parseInspiration } from './inspiration-digest.js';

export async function runInspirationDigest({
  readers, dispatchAnalyst, writeFile, file,
  now = Date.now(), maxSeeds = 7, staleMs = 172_800_000, log = () => {},
} = {}) {
  const signals = await gatherSignals(readers, { now, staleMs });
  const prompt = buildInspirationPrompt(signals, { maxSeeds });
  let res;
  try { res = await dispatchAnalyst({ prompt }); }
  catch (e) { log('inspiration: analyst dispatch failed:', e?.message || e); return { status: 'skip', seeds: [], degraded: signals.degraded }; }
  if (!res?.done || !res?.text) { log('inspiration: analyst not done — keeping last good digest'); return { status: 'skip', seeds: [], degraded: signals.degraded }; }
  const { seeds } = parseInspiration(res.text, { maxSeeds });
  const digest = { generatedAt: new Date(now).toISOString(), sources: signals.sources, degraded: signals.degraded, seeds };
  await writeFile(file, JSON.stringify(digest)); // caller passes an ATOMIC writer (tmp+rename)
  return { status: 'ok', seeds, degraded: signals.degraded };
}
