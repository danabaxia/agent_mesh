// Impure: append/read/prune the daily activity JSONL files. recordActivity is
// FAIL-SAFE — it must never throw into a daemon loop. read/prune are tolerant.
import { mkdirSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatEvent, filterEvents } from './event.js';

const dateOf = (d) => d.toISOString().slice(0, 10);                 // YYYY-MM-DD
const DATE_RE = /^activity-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function recordActivity(input, { dir, now = () => new Date() } = {}) {
  try {
    const t = now();
    const ev = formatEvent(input, { now: () => t });
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `activity-${dateOf(t)}.jsonl`), JSON.stringify(ev) + '\n');
  } catch { /* logging must never break the caller */ }
}

/**
 * Recent events, newest-first, since-windowed, capped. (agent/type/level filtering
 * is applied by callers via filterEvents — this does file scan + since + sort + cap.)
 */
export function readActivity({ dir, since, limit = 200, maxFiles = 14 } = {}) {
  let names;
  try { names = readdirSync(dir).filter((f) => DATE_RE.test(f)); } catch { return []; }
  names.sort().reverse();                                            // newest date first
  const sinceDate = since ? String(since).slice(0, 10) : null;
  const picked = sinceDate ? names.filter((f) => f.match(DATE_RE)[1] >= sinceDate) : names.slice(0, maxFiles);
  const out = [];
  for (const f of picked) {
    let lines;
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));  // newest first
  const windowed = since ? filterEvents(out, { since }) : out;
  return windowed.slice(0, limit);
}

export function pruneActivity({ dir, keepDays = 30, now = () => new Date() } = {}) {
  const removed = [];
  let names;
  try { names = readdirSync(dir).filter((f) => DATE_RE.test(f)); } catch { return { removed }; }
  const cutoffDate = dateOf(new Date(now().getTime() - keepDays * 86_400_000));
  for (const f of names) {
    if (f.match(DATE_RE)[1] < cutoffDate) {
      try { rmSync(join(dir, f)); removed.push(f); } catch { /* ignore */ }
    }
  }
  return { removed };
}
