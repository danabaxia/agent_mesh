import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMir } from '../scripts/mir-run.mjs';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('the tester-suite-run builtin is registered in the daemon', () => {
  assert.match(daemon, /'tester-suite-run'\s*:/);
});

test('runMir dry-run produces a plan and performs no gh mutation', async () => {
  let ghCalls = 0;
  const res = await runMir({
    repoRoot: process.cwd(), ref: { commit: 'test', branch: 'main' },
    dryRun: true, runSuites: false, gh: async () => { ghCalls++; return ''; },
    now: () => new Date('2026-06-20T06:30:00Z'),
    syncArtifacts: async () => [],   // hermetic: don't hit `gh` to stage CI eval artifacts
  });
  assert.equal(res.status, 'ok');
  assert.equal(ghCalls, 0);
  assert.equal(res.mutations, 0);
});
