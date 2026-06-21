import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

test('analyst schedule has the research-escalation builtin job (every 120 min)', () => {
  const sched = JSON.parse(readFileSync(join(repoRoot, 'dev-mesh', 'analyst', '.agent', 'schedule.json'), 'utf8'));
  const job = sched.jobs.find((j) => j.id === 'research-escalation');
  assert.ok(job, 'research-escalation job must exist');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.builtin, 'research-escalation');
  assert.equal(job.enabled, true);
  assert.equal(job.cadence.kind, 'every');
  assert.equal(job.cadence.minutes, 120);
});

test('research-escalation SKILL.md has frontmatter + the research-only (no-code) + untrusted rule', () => {
  const skill = readFileSync(join(repoRoot, 'dev-mesh', 'analyst', 'skills', 'research-escalation', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---/);
  assert.match(skill, /name:\s*research-escalation/);
  assert.match(skill, /description:/);
  assert.match(skill, /never code|analysis only|no code/i);
  assert.match(skill, /untrusted/i);
});

test('daemon registers the research-escalation builtin', () => {
  const daemon = readFileSync(join(repoRoot, 'scripts', 'dev-society-daemon.mjs'), 'utf8');
  assert.match(daemon, /'research-escalation':\s*async/);
  assert.match(daemon, /runResearchEscalation/);
});
