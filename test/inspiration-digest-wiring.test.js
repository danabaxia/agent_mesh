// Lint: verify dev-society-daemon.mjs registers the 'inspiration-digest' builtin
// and imports runInspirationDigest — mirrors the style of research-escalation-wiring.test.js
// and the existing schedule/daemon lint tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonSrc = readFileSync(join(__dirname, '..', 'scripts', 'dev-society-daemon.mjs'), 'utf8');

test("dev-society-daemon.mjs registers 'inspiration-digest' builtin", () => {
  assert.ok(
    daemonSrc.includes("'inspiration-digest'"),
    "daemon must register 'inspiration-digest' in the builtins object",
  );
});

test('dev-society-daemon.mjs imports runInspirationDigest', () => {
  assert.ok(
    daemonSrc.includes('runInspirationDigest'),
    'daemon must import and use runInspirationDigest',
  );
});

test("analyst schedule.json contains an 'inspiration-digest' job with daily cadence", () => {
  const scheduleJson = readFileSync(
    join(__dirname, '..', 'dev-mesh', 'analyst', '.agent', 'schedule.json'),
    'utf8',
  );
  const schedule = JSON.parse(scheduleJson);
  const job = schedule.jobs.find((j) => j.builtin === 'inspiration-digest');
  assert.ok(job, "schedule.json must contain a job with builtin === 'inspiration-digest'");
  assert.strictEqual(
    job.cadence?.kind,
    'daily',
    "inspiration-digest job cadence must be 'daily'",
  );
});
