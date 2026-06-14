import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/probe-headroom.mjs', import.meta.url));

test('probe-headroom --help prints usage and exits 0 (no claude required)', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(out, /probe-headroom/);
  assert.match(out, /assumption 1/i);
  assert.match(out, /assumption 2/i);
});
