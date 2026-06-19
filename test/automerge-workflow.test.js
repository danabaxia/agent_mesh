import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wf = readFileSync(fileURLToPath(new URL('../.github/workflows/dev-mesh-automerge.yml', import.meta.url)), 'utf8');

test('automerge workflow: scheduled + manual, ubuntu, safe concurrency', () => {
  assert.match(wf, /^on:/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /cron:\s*'[^']+'/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /runs-on:\s*ubuntu-latest/);
  assert.match(wf, /cancel-in-progress:\s*false/);
});

test('automerge workflow: gated by the AUTOMERGE_ENABLED repo variable + runs the sweep', () => {
  assert.match(wf, /AUTOMERGE_ENABLED:\s*\$\{\{\s*vars\.AUTOMERGE_ENABLED\s*\}\}/);
  assert.match(wf, /automerge-sweep\.mjs/);
});

test('automerge workflow: mechanical — has merge perms, no claude', () => {
  assert.match(wf, /pull-requests:\s*write/);
  assert.match(wf, /contents:\s*write/);
  assert.doesNotMatch(wf, /CLAUDE_CODE_OAUTH_TOKEN|anthropic/i);
});
