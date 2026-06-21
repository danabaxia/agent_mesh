import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

test('coder schedule has the research-fix builtin job (every 60 min)', () => {
  const sched = JSON.parse(readFileSync(join(repoRoot, 'dev-mesh', 'coder', '.agent', 'schedule.json'), 'utf8'));
  const job = sched.jobs.find((j) => j.id === 'research-fix');
  assert.ok(job);
  assert.equal(job.kind, 'builtin');
  assert.equal(job.builtin, 'research-fix');
  assert.equal(job.enabled, true);
  assert.equal(job.cadence.kind, 'every');
  assert.equal(job.cadence.minutes, 60);
});

test('daemon registers the research-fix builtin + runDraftFixBuild', () => {
  const daemon = readFileSync(join(repoRoot, 'scripts', 'dev-society-daemon.mjs'), 'utf8');
  assert.match(daemon, /'research-fix':\s*async/);
  assert.match(daemon, /runResearchFix/);
  assert.match(daemon, /async function runDraftFixBuild/);
});
