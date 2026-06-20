// test/deploy-install-lint.test.js — hermetic lint of the cutover script's --dry-run
// output + its live-mode root-mismatch guard. Never invokes real launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/dev-society-deploy-install.sh', import.meta.url));

// PATH-shadow launchctl with a stub that fails loudly if invoked, so any real
// launchctl call during --dry-run / the mismatch guard fails the test.
function stubPath() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const lc = join(dir, 'launchctl');
  writeFileSync(lc, '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n');
  chmodSync(lc, 0o755);
  return `${dir}:${process.env.PATH}`;
}

test('--dry-run emits correct daemon + deploy-sync plists and dedupe, no launchctl', () => {
  const r = spawnSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: stubPath(), DEV_SOCIETY_DEPLOY_ROOT: '/tmp/x', DEV_SOCIETY_REPO: 'o/r' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  // daemon plist points at the deploy worktree, with env
  assert.match(out, /<string>\/tmp\/x\/scripts\/dev-society-daemon\.mjs<\/string>/);
  assert.match(out, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/x<\/string>/);
  assert.match(out, /<key>DEV_SOCIETY_REPO<\/key>/);
  assert.match(out, /<key>PATH<\/key>/);
  assert.match(out, /com\.danabaxia\.agent-mesh\.dev-society/);
  // deploy-sync plist
  assert.match(out, /com\.danabaxia\.agent-mesh\.deploy-sync/);
  assert.match(out, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(out, /<key>DEV_SOCIETY_DAEMON_LABEL<\/key>/);
  // legacy dedupe + bootout->bootstrap ordering (not bare kickstart-only)
  assert.match(out, /com\.danabaxia\.dev-society(?!\.)/);   // legacy label mentioned
  assert.match(out, /bootout/);
  assert.match(out, /bootstrap/);
  assert.match(out, /enable/);
  assert.match(out, /kickstart/);
});

test('live mode rejects a mismatching DEV_SOCIETY_DEPLOY_ROOT before any side effect', () => {
  const fakeLaDir = mkdtempSync(join(tmpdir(), 'la-'));
  const r = spawnSync('bash', [script], {   // no --dry-run
    encoding: 'utf8',
    env: { ...process.env, PATH: stubPath(), HOME: fakeLaDir, DEV_SOCIETY_DEPLOY_ROOT: '/nope/not/script/root' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /refusing|mismatch|!=/i);
  // nothing written under the fake LaunchAgents dir
  const la = join(fakeLaDir, 'Library', 'LaunchAgents');
  assert.ok(!existsSync(la) || readdirSync(la).length === 0);
});
