// Verifies the mesh WRITE path (fileMeshTask) at the code level with a FAKE `gh`
// on PATH — proves command construction, label allowlist, and URL parsing without
// any real external write. The live `gh issue create` is owner-triggered in use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeDir = mkdtempSync(join(tmpdir(), 'fakegh-'));
const argsLog = join(fakeDir, 'args.txt');
// Fake gh: log argv, print a fake issue URL for `issue create`.
writeFileSync(join(fakeDir, 'gh'),
  `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argsLog}"\ncase "$1 $2" in\n"issue create") echo "https://github.com/o/r/issues/777" ;;\n*) echo "{}" ;;\nesac\n`);
chmodSync(join(fakeDir, 'gh'), 0o755);
process.env.PATH = `${fakeDir}:${process.env.PATH}`;

const { fileMeshTask } = await import('./mesh-tools.mjs');

test('fileMeshTask: builds gh args, returns parsed url + number, default label idea', async () => {
  const out = await fileMeshTask({ title: 'Add voice entry', body: '说话→听懂→回报' });
  assert.equal(out.url, 'https://github.com/o/r/issues/777');
  assert.equal(out.number, '777');
  assert.deepEqual(out.labels, ['idea']);
  const logged = readFileSync(argsLog, 'utf8');
  assert.ok(logged.includes('--title') && logged.includes('Add voice entry'), 'title passed');
  assert.ok(logged.includes('--label') && logged.includes('idea'), 'default label idea passed to gh');
});

test('fileMeshTask: drops non-allowlisted labels, keeps allowed ones', async () => {
  const out = await fileMeshTask({ title: 'T', body: 'B', labels: ['evil', 'approved', 'route:a2a'] });
  assert.deepEqual(out.labels, ['approved', 'route:a2a'], 'evil dropped, approved+route:a2a kept');
});

test('fileMeshTask: empty title rejected before any gh spawn', async () => {
  await assert.rejects(() => fileMeshTask({ title: '  ', body: 'x' }), /title required/);
});
