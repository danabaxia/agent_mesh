// test/dev-mesh-memory.test.js — Phase-2 wiring proof (Task 8). The Dev-mesh roles
// persist lessons in dev-mesh/<role>/memory/quick.json, and a later run prefetches
// the relevant ones into the worker prompt. This asserts the SEED memory is valid
// under the framework's caps AND that the EXISTING prefetch machinery
// (src/prefetch.js + src/quick-memory.js — the same code the live mesh uses)
// selects the matching lesson for a matching task. So self-evolution is real
// (reuses proven machinery), not a parallel implementation.
// Spec: docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md §10/§16
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readQuickMemory, validateQuickMemory, isLive } from '../src/quick-memory.js';
import { selectPrefetch } from '../src/prefetch.js';

const root = (role) => fileURLToPath(new URL(`../dev-mesh/${role}/`, import.meta.url));

test('seed memory validates under the framework caps (fail-closed shape)', async () => {
  for (const role of ['coder', 'triager']) {
    const quick = await readQuickMemory(root(role));
    assert.ok(Object.keys(quick).length > 0, `${role}: seed memory should be non-empty`);
    assert.doesNotThrow(() => validateQuickMemory(quick), `${role}: seed must satisfy caps/shape`);
    for (const [k, e] of Object.entries(quick)) {
      assert.ok(isLive(e), `${role}/${k}: seed entries must be live (status active, valid_to null)`);
    }
  }
});

test('prefetch selects the matching lesson for a matching Coder task', async () => {
  const quick = await readQuickMemory(root('coder'));
  // A Windows-spawn task should surface the win-cmd-spawn lesson first.
  const sel = selectPrefetch(quick, 'fix the windows claude .cmd spawn EINVAL when launching the process');
  assert.equal(sel.weak, false, 'a clearly-matching task must not fall back to weak mode');
  assert.equal(sel.picked[0].key, 'win-cmd-spawn', 'top pick should be the spawn lesson');
});

test('prefetch is discriminating — an unrelated lesson outranks for its own task', async () => {
  const quick = await readQuickMemory(root('coder'));
  const sel = selectPrefetch(quick, 'the dashboard reopened the wrong session context with --continue, use the id');
  assert.equal(sel.picked[0].key, 'dashboard-resume-id', 'session task should pick the resume-id lesson, not the spawn one');
});

test('prefetch selects the flake-triage lesson for a CI-failure task (Triager)', async () => {
  const quick = await readQuickMemory(root('triager'));
  // Lexical matcher (no stemming): use the lesson's own vocabulary — an
  // intermittent failure unrelated to the diff that we might re-kick.
  const sel = selectPrefetch(quick, 'a CI failure looks intermittent and unrelated to the diff — should I re-kick this flake?');
  assert.equal(sel.weak, false);
  assert.equal(sel.picked[0].key, 'ci-flake-rekick', 'should pick the re-kick lesson over the container-signing one');
});

test('an unrelated task gets no false-positive prefetch (weak fallback)', async () => {
  const quick = await readQuickMemory(root('coder'));
  const sel = selectPrefetch(quick, 'refactor the quarterly billing invoice currency rounding');
  assert.equal(sel.weak, true, 'no seed lesson matches → weak (caller injects core + L1, not L2 bodies)');
});
