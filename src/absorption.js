// src/absorption.js — repetition detection for the absorption pipeline (spec §9).
// PURE, zero-dependency. Mines an agent's run records for recurring task clusters
// using TWO signals that must AGREE for workflow candidacy:
//   1. task-text similarity (lexical Jaccard over normalized tokens), and
//   2. artifact-diff pattern (recurring files_changed shapes).
// A single signal → a memory candidate only, not workflow-worthy. The model
// (ask-only digest worker) confirms a cluster + writes the drafts; that's impure
// and stubbed in tests. Here we only decide candidacy.

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'your', 'you', 'please',
  'create', 'file', 'task']);

/** Normalize task text → a Set of salient lowercased word tokens (stopwords dropped). */
export function taskTokens(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter((w) => w.length > 2 && !STOP.has(w)));
}

/** Jaccard similarity of two token sets (0..1; empty∩empty = 0). */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** A normalized signature of a run's files_changed — directory shape + extensions,
 *  so "src/a.js"+"src/b.js" cluster with "src/c.js" (a recurring PRODUCT shape). */
export function artifactSignature(filesChanged) {
  if (!Array.isArray(filesChanged)) return '';
  const shapes = filesChanged.map((f) => {
    const s = String(f);
    const dir = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : '';
    const ext = s.includes('.') ? s.slice(s.lastIndexOf('.')) : '';
    return `${dir}/*${ext}`;
  });
  return [...new Set(shapes)].sort().join('|');
}

/** files_changed for a run record (tolerates the run-record nesting). */
function runArtifacts(run) {
  return run?.result?.files_changed ?? run?.files_changed ?? null;
}

/**
 * Cluster run records into recurring-task groups. A cluster needs ≥2 members whose
 * task texts are pairwise similar (≥ simThreshold) AND share an artifact signature.
 * Returns [{ tasks:[...], runIds:[...], signature, size }] sorted by size desc.
 * Greedy single-link clustering — deterministic, no deps.
 */
export function recurringClusters(runs, { simThreshold = 0.5, minSize = 2 } = {}) {
  const items = (runs || [])
    .map((r) => ({ run: r, tokens: taskTokens(r.task), sig: artifactSignature(runArtifacts(r)) }))
    .filter((it) => it.tokens.size > 0);
  const used = new Array(items.length).fill(false);
  const clusters = [];
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    const group = [i];
    used[i] = true;
    for (let j = i + 1; j < items.length; j++) {
      if (used[j]) continue;
      const bothSignals = jaccard(items[i].tokens, items[j].tokens) >= simThreshold
        && items[i].sig !== '' && items[i].sig === items[j].sig;     // task-sim AND artifact-diff agree
      if (bothSignals) { group.push(j); used[j] = true; }
    }
    if (group.length >= minSize) {
      clusters.push({
        tasks: group.map((k) => items[k].run.task),
        runIds: group.map((k) => items[k].run.id).filter(Boolean),
        signature: items[i].sig,
        size: group.length
      });
    }
  }
  return clusters.sort((a, b) => b.size - a.size);
}
