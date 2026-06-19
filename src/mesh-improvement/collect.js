// src/mesh-improvement/collect.js — impure: locate + read already-persisted producer JSON.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Newest `filename` under any immediate subdir of `dir` (eval runners write timestamped dirs). */
export function latestJson(dir, filename) {
  if (!dir || !existsSync(dir)) return null;
  let best = null, bestMtime = -1;
  for (const entry of readdirSync(dir)) {
    const candidate = join(dir, entry, filename);
    if (!existsSync(candidate)) continue;
    const m = statSync(candidate).mtimeMs;
    if (m > bestMtime) { bestMtime = m; best = candidate; }
  }
  return best ? readJson(best) : null;
}

function readRunLogs(logDir) {
  if (!logDir || !existsSync(logDir)) return [];
  const byId = new Map();
  for (const f of readdirSync(logDir)) {
    if (!/^delegate-.*\.jsonl$/.test(f)) continue;
    for (const line of readFileSync(join(logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.id) byId.set(r.id, r); } catch { /* skip */ }
    }
  }
  return [...byId.values()].filter((r) => r.state === 'done' || r.status);
}

function latestMir(mirDir) {
  if (!mirDir || !existsSync(mirDir)) return null;
  const files = readdirSync(mirDir).filter((f) => /^mir-.*\.json$/.test(f)).sort();
  return files.length ? readJson(join(mirDir, files[files.length - 1])) : null;
}

export function collectInputs({ resultsRoots, logDir, mirDir }) {
  const inputs = {
    tests: resultsRoots.tests && existsSync(resultsRoots.tests) ? readJson(resultsRoots.tests) : null,
    behavior: latestJson(resultsRoots.behavior, 'scorecard.json'),
    adversarial: latestJson(resultsRoots.adversarial, 'scorecard.json'),
    perf: latestJson(resultsRoots.perf, 'perfcard.json'),
    runLogs: readRunLogs(logDir),
  };
  return { inputs, previousMir: latestMir(mirDir) };
}
