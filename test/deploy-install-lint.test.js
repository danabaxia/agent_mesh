// test/deploy-install-lint.test.js — hermetic lint of the cutover script's --dry-run
// output + its live-mode root-mismatch guard. Never invokes real launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The deploy install script is a macOS/launchd bash artifact (POSIX PATH semantics,
// chmod-executable stubs, launchctl). Its lint is POSIX-only — skip on Windows,
// mirroring test/demo-e2e.test.js. deploy-sync.test.js stays cross-platform.
const POSIX_ONLY = process.platform === 'win32'
  ? 'POSIX-only: deploy install targets macOS launchd'
  : false;

const script = fileURLToPath(new URL('../scripts/dev-society-deploy-install.sh', import.meta.url));

// PATH-shadow launchctl with a stub that fails loudly if invoked, so any real
// launchctl call during --dry-run / the mismatch guard fails the test.
// Also plant fake claude/gh/node so command -v resolves them in the stub dir.
function stubPath() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  for (const name of ['launchctl', 'claude', 'gh', 'node']) {
    const p = join(dir, name);
    if (name === 'launchctl') {
      writeFileSync(p, '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n');
    } else {
      // minimal no-op stubs so command -v finds them
      writeFileSync(p, `#!/bin/sh\nexec /usr/bin/env ${name === 'node' ? 'node' : 'true'} "$@"\n`);
    }
    chmodSync(p, 0o755);
  }
  return `${dir}:${process.env.PATH}`;
}

test('--dry-run emits correct daemon + deploy-sync plists and dedupe, no launchctl', { skip: POSIX_ONLY }, () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  for (const name of ['launchctl', 'claude', 'gh', 'node']) {
    const p = join(stubDir, name);
    writeFileSync(p, name === 'launchctl'
      ? '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n'
      : '#!/bin/sh\ntrue\n');
    chmodSync(p, 0o755);
  }
  const stubPathVal = `${stubDir}:${process.env.PATH}`;

  const r = spawnSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: stubPathVal, DEV_SOCIETY_DEPLOY_ROOT: '/tmp/x', DEV_SOCIETY_REPO: 'o/r' },
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
  // Fix 2: RunAtLoad present in both daemon and sync plists
  assert.match(out, /<key>RunAtLoad<\/key>/);
  assert.match(out, /<true\/>/);
  // Fix 1: AGENT_MESH_CLAUDE wired in daemon plist (claude stub found on PATH)
  assert.match(out, /<key>AGENT_MESH_CLAUDE<\/key>/);
  // stub dir appears in the PATH value (claude/gh dirs are resolvable)
  assert.ok(out.includes(stubDir), `expected stub dir ${stubDir} in PATH output`);
});

test('live mode rejects a mismatching DEV_SOCIETY_DEPLOY_ROOT before any side effect', { skip: POSIX_ONLY }, () => {
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

test('live mode rejects empty DEV_SOCIETY_REPO before any mkdir/write', { skip: POSIX_ONLY }, () => {
  // Builds a stub PATH that includes fake claude/gh/node + fail-loud launchctl.
  // DEV_SOCIETY_REPO is explicitly unset (empty string) — preflight must exit 1
  // before any mkdir or plist write.
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  for (const name of ['launchctl', 'claude', 'gh', 'node']) {
    const p = join(stubDir, name);
    writeFileSync(p, name === 'launchctl'
      ? '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n'
      : '#!/bin/sh\ntrue\n');
    chmodSync(p, 0o755);
  }
  const fakeHome = mkdtempSync(join(tmpdir(), 'home-'));
  const r = spawnSync('bash', [script], {   // no --dry-run; no DEV_SOCIETY_DEPLOY_ROOT → pins to script root
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: fakeHome,
      DEV_SOCIETY_REPO: '',   // explicitly empty — triggers preflight guard
    },
  });
  assert.notEqual(r.status, 0, 'expected non-zero exit when DEV_SOCIETY_REPO is empty');
  assert.match(r.stderr + r.stdout, /DEV_SOCIETY_REPO/i);
  // Nothing written under fake HOME's LaunchAgents — preflight exited before any mkdir
  const la = join(fakeHome, 'Library', 'LaunchAgents');
  assert.ok(!existsSync(la) || readdirSync(la).length === 0,
    'LaunchAgents dir must be empty — preflight should exit before any write');
});

test('--dry-run emits the dashboard plist + sync env + reload', { skip: POSIX_ONLY }, () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  for (const name of ['launchctl', 'claude', 'gh', 'node']) {
    const p = join(stubDir, name);
    writeFileSync(p, name === 'launchctl'
      ? '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n'
      : '#!/bin/sh\ntrue\n');
    chmodSync(p, 0o755);
  }
  const r = spawnSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, DEV_SOCIETY_DEPLOY_ROOT: '/tmp/x', DEV_SOCIETY_REPO: 'o/r' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /com\.danabaxia\.agent-mesh\.dashboard\.plist/);
  assert.match(out, /<string>dashboard<\/string>/);
  assert.match(out, /\/tmp\/x\/dev-mesh/);
  assert.match(out, /<string>--no-open<\/string>/);
  assert.match(out, /<string>--port<\/string><string>7077<\/string>/);
  assert.match(out, /<key>KeepAlive<\/key><true\/>/);
  assert.match(out, /<key>DEV_SOCIETY_DASHBOARD_LABEL<\/key><string>com\.danabaxia\.agent-mesh\.dashboard<\/string>/);
  assert.match(out, /reload dashboard/);
});
