import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const PUB = join('src', 'dashboard', 'public');
function htmlEntryModules() {
  const entries = new Set();
  for (const f of readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(PUB, f), 'utf8');
    for (const m of html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']\/?([^"']+\.js)["']/g)) entries.add(m[1].split('/').pop());
  }
  return entries;
}
function importsOf(file) {
  const src = readFileSync(join(PUB, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/\bfrom\s+["']\.?\/?([^"']+\.js)["']/g)) names.add(m[1].split('/').pop());
  for (const m of src.matchAll(/\bimport\(\s*["']\.?\/?([^"']+\.js)["']\s*\)/g)) names.add(m[1].split('/').pop());
  return names;
}
function reachable() {
  const all = new Set(readdirSync(PUB).filter((f) => f.endsWith('.js')));
  const seen = new Set();
  const stack = [...htmlEntryModules()].filter((f) => all.has(f));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) if (all.has(dep) && !seen.has(dep)) stack.push(dep);
  }
  return { all, seen };
}
const ALLOWLIST = new Set([
  // New pure helper modules added by this QA plan (Plan 1 Tasks 2 & 3).
  // Not yet imported by any board2.js/graph-view.js consumer; future-wired for
  // when the Graph view wires up the KPI helpers and the poll loop is extracted.
  'freshness.js',         // Plan 1 Task 2: pure isStale/backoffDelays — future consumer
  'graph-view-model.js',  // Plan 1 Task 3: pure issuesLabel/tokenTotal — future consumer
]);
test('no orphaned client modules (unreferenced by any HTML entry import graph)', () => {
  const { all, seen } = reachable();
  const orphans = [...all].filter((f) => !seen.has(f) && !ALLOWLIST.has(f)).sort();
  assert.deepEqual(orphans, [], `orphaned modules (dead, or add to ALLOWLIST with reason): ${orphans.join(', ')}`);
});
