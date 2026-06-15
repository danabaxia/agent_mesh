#!/usr/bin/env node
// scripts/validate-quick-memory.mjs <quick.json ...> — the light check that replaces
// the heavy CI matrix for memory:promote PRs. Throws (non-zero exit) if any file is
// not valid JSON or violates the quick-memory caps/shape. Used by
// dev-mesh-memory-automerge.yml before it auto-merges a memory PR.
import { readFileSync } from 'node:fs';
import { validateQuickMemory } from '../src/quick-memory.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('no quick.json paths given');
  process.exit(1);
}
for (const f of files) {
  validateQuickMemory(JSON.parse(readFileSync(f, 'utf8')));
  console.log('valid:', f);
}
