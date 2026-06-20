import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../run-all-tests.mjs', import.meta.url));

test('--json writes the report before a nonzero exit on red', () => {
  const root = mkdtempSync(join(tmpdir(), 'mir-rat-'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'red.test.js'),
    "import t from 'node:test';import a from 'node:assert';t('x',()=>a.equal(1,2));");
  const out = join(root, 'tr.json');
  // Create a clean env without test-related variables to avoid "recursive test" warning
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_NAME_PATTERN;
  const r = spawnSync(process.execPath, [runner, '--json', out], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
  assert.notEqual(r.status, 0);                 // red suite still exits nonzero
  assert.ok(existsSync(out));                    // ...but the JSON was written first
  const json = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(json.summary.red, 1);
  assert.equal(json.results[0].f, 'red.test.js');
});
