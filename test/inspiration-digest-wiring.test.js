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
