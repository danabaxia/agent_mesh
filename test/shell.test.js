/**
 * test/shell.test.js — Inc 1: native CLI launch builder (encoders, plan, I/O).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodePosix, encodeCmd, assertNoControlChars, ShellInputError,
  detectOpener, buildLaunchPlan, writePlanFiles, openTerminal
} from '../src/dashboard/shell.js';

// --- encoders ---

test('encodePosix wraps + escapes single quotes; survives shell metachars', () => {
  assert.equal(encodePosix(`/tmp/a'b`), `'/tmp/a'\\''b'`);
  // metacharacters are inert inside single quotes
  for (const v of ['/x/$(rm -rf)', '/x/`id`', '/x/a&b|c', '/x/with space']) {
    assert.ok(encodePosix(v).startsWith("'") && encodePosix(v).endsWith("'"));
  }
});

test('encodeCmd quotes + carets cmd metachars', () => {
  const out = encodeCmd('A=%PATH% & echo !x! | type');
  assert.ok(out.startsWith('"') && out.endsWith('"'));
  assert.ok(out.includes('^%') && out.includes('^!') && out.includes('^&') && out.includes('^|'));
});

test('control chars are rejected; spaces are allowed', () => {
  assert.throws(() => assertNoControlChars('a\nb'), ShellInputError);
  assert.throws(() => assertNoControlChars('a\rb'), ShellInputError);
  assert.throws(() => assertNoControlChars('a\x00b'), ShellInputError);
  assert.doesNotThrow(() => assertNoControlChars('/tmp/agent mesh/library'));
});

// --- detectOpener ---

test('detectOpener: darwin prefers iTerm (else Terminal) / win32(+wt) / unsupported', () => {
  assert.deepEqual(detectOpener('darwin', { appExists: () => true }), { kind: 'darwin', macApp: 'iTerm', hasWt: false });
  assert.deepEqual(detectOpener('darwin', { appExists: () => false }), { kind: 'darwin', macApp: 'Terminal', hasWt: false });
  assert.deepEqual(detectOpener('win32', { which: (c) => c === 'wt' }), { kind: 'win32', hasWt: true });
  assert.deepEqual(detectOpener('win32', { which: () => false }), { kind: 'win32', hasWt: false });
  assert.deepEqual(detectOpener('linux'), { kind: 'unsupported', hasWt: false });
});

// --- buildLaunchPlan ---

const ENV = { AGENT_MESH_MESH_ROOT: '/m/mesh', AGENT_MESH_ENABLED_MODES: 'ask,do' };

test('darwin plan → .command script; iTerm uses osascript (open -a doesn\'t exec .command in iTerm)', () => {
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false } });
  assert.equal(plan.scriptName, 'launch.command');
  assert.match(plan.scriptBody, /^#!\/bin\/sh/);
  assert.match(plan.scriptBody, /cd '\/m\/lib'/);
  assert.match(plan.scriptBody, /export AGENT_MESH_MESH_ROOT='\/m\/mesh'/);
  assert.match(plan.scriptBody, /exec claude --strict-mcp-config --mcp-config '\/t\/cfg\.json'/);
  const escapedScriptPath = plan.scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  assert.deepEqual(plan.openerArgv, [
    'osascript',
    '-e', 'tell application "iTerm" to activate',
    '-e', `tell application "iTerm" to create window with default profile command "${escapedScriptPath}"`
  ]);
  assert.match(plan.command, /^cd '\/m\/lib' && /);
});

test('darwin plan → Terminal uses native `open -a Terminal …` (Terminal handles .command natively)', () => {
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'Terminal', hasWt: false } });
  assert.deepEqual(plan.openerArgv, ['open', '-a', 'Terminal', plan.scriptPath]);
});

test('buildLaunchPlan threads --resume <id> when resumeId given (darwin + posix copy-string)', () => {
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false }, resumeId: 'abc-123' });
  assert.match(plan.scriptBody, /exec claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --resume 'abc-123'/);
  assert.match(plan.command, /claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --resume 'abc-123'/);
});

test('buildLaunchPlan threads --session-id <id> for first canonical CLI launch', () => {
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false }, sessionId: 'abc-123' });
  assert.match(plan.scriptBody, /exec claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --session-id 'abc-123'/);
  assert.match(plan.command, /claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --session-id 'abc-123'/);
});

test('buildLaunchPlan threads --continue for latest cwd session', () => {
  const mac = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false }, continueSession: true });
  assert.match(mac.scriptBody, /exec claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --continue/);
  assert.match(mac.command, /claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --continue/);

  const win = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: false }, continueSession: true });
  assert.match(win.scriptBody, /claude --strict-mcp-config --mcp-config 'C:\/t\/cfg\.json' --continue/);
  assert.match(win.command, /claude --strict-mcp-config --mcp-config 'C:\/t\/cfg\.json' --continue/);
});

test('buildLaunchPlan disables native Claude setting sources for terminal launches', () => {
  const mac = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false } });
  assert.match(mac.scriptBody, /--setting-sources ''/);
  assert.match(mac.command, /--setting-sources ''/);

  const win = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: false } });
  assert.match(win.scriptBody, /--setting-sources ''/);
  assert.match(win.command, /--setting-sources ''/);
});

test('buildLaunchPlan threads --resume <id> on win32 (.ps1 script + ps copy-string, single-quoted)', () => {
  const plan = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: false }, resumeId: 'abc-123' });
  assert.match(plan.scriptBody, /claude --strict-mcp-config --mcp-config 'C:\/t\/cfg\.json' --resume 'abc-123'/);
  assert.match(plan.command, /claude --strict-mcp-config --mcp-config 'C:\/t\/cfg\.json' --resume 'abc-123'/);
});

test('buildLaunchPlan: no resumeId → no --resume flag (darwin + win32)', () => {
  const mac = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false } });
  assert.ok(!/--resume/.test(mac.scriptBody));
  const win = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: false } });
  assert.ok(!/--resume/.test(win.scriptBody));
});

test('win32 plan → .ps1 run by PowerShell directly (NO cmd.exe — EDR behavioral flags)', () => {
  // CrowdStrike repeatedly blocked the launcher's cmd.exe chains (detached
  // `cmd /c start` + env-set batch scripts read as malicious automation).
  // The launch path must not touch cmd.exe at all: a .ps1 script, opened via
  // `wt … powershell -File` or by spawning powershell detached (own console).
  const wt = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: true } });
  assert.equal(wt.scriptName, 'launch.ps1');
  assert.match(wt.scriptBody, /Set-Location -LiteralPath 'C:\/m\/lib'/);
  assert.match(wt.scriptBody, /\$env:[A-Z_]+ = '/);
  assert.match(wt.scriptBody, /claude --strict-mcp-config --mcp-config 'C:\/t\/cfg\.json'/);
  assert.deepEqual(wt.openerArgv.slice(0, 4), ['wt', '-d', 'C:/m/lib', 'powershell']);
  assert.ok(wt.openerArgv.includes('-File'));
  const noWt = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: false } });
  assert.equal(noWt.openerArgv[0], 'powershell');
  assert.ok(noWt.openerArgv.includes('-File'));
  assert.ok(!noWt.openerArgv.includes('cmd'), 'cmd.exe must not appear anywhere in the opener');
  // CrowdStrike kills any node-spawned powershell whose command line carries
  // `-ExecutionPolicy Bypass` — before the script's first line runs, no window,
  // no error (isolated live 2026-06-12: identical detached spawn ran fine with
  // the flag removed). `-File` of a local script needs no policy override on
  // RemoteSigned/Bypass hosts, so the flag must stay out of BOTH opener forms.
  assert.ok(!wt.openerArgv.includes('-ExecutionPolicy'), 'wt opener must not carry -ExecutionPolicy (EDR kill)');
  assert.ok(!noWt.openerArgv.includes('-ExecutionPolicy'), 'powershell opener must not carry -ExecutionPolicy (EDR kill)');
});

test('unsupported platform → no script/opener, copyable command present', () => {
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'unsupported', hasWt: false } });
  assert.equal(plan.openerArgv, null);
  assert.equal(plan.scriptBody, null);
  assert.match(plan.command, /claude --strict-mcp-config --mcp-config/);
});

test('buildLaunchPlan: --settings <path> appended when skillSettingsPath given (darwin + win32), omitted otherwise', () => {
  const mac = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false }, skillSettingsPath: '/t/skill-settings.json' });
  assert.match(mac.scriptBody, /--settings '\/t\/skill-settings\.json'/);
  assert.match(mac.command, /--settings '\/t\/skill-settings\.json'/);

  const win = buildLaunchPlan({ agentRoot: 'C:/m/lib', env: ENV, bridgeConfigPath: 'C:/t/cfg.json', tempDir: 'C:/t', opener: { kind: 'win32', hasWt: false }, skillSettingsPath: 'C:/t/skill-settings.json' });
  assert.match(win.scriptBody, /--settings 'C:\/t\/skill-settings\.json'/);

  const none = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false } });
  assert.ok(!/--settings/.test(none.scriptBody));
  assert.ok(!/--settings/.test(none.command));
});

test('a CR/LF in agentRoot or env is rejected at plan time', () => {
  assert.throws(() => buildLaunchPlan({ agentRoot: '/m/lib\nrm -rf /', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', hasWt: false } }), ShellInputError);
  assert.throws(() => buildLaunchPlan({ agentRoot: '/m/lib', env: { X: 'a\nb' }, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', hasWt: false } }), ShellInputError);
});

// --- writePlanFiles / openTerminal (injected I/O) ---

test('writePlanFiles: exclusive dir + 0600 files + 0700 script', async () => {
  const calls = { mkdir: [], writeFile: [], chmod: [] };
  const io = {
    mkdir: async (d, o) => calls.mkdir.push({ d, o }),
    writeFile: async (p, _b, o) => calls.writeFile.push({ p, o }),
    chmod: async (p, m) => calls.chmod.push({ p, m })
  };
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', hasWt: false } });
  await writePlanFiles(plan, '/t/cfg.json', '{}', io);
  assert.equal(calls.mkdir[0].d, '/t');
  assert.equal(calls.mkdir[0].o.recursive, false);     // exclusive
  assert.ok(calls.writeFile.every((w) => w.o.flag === 'wx' && w.o.mode === 0o600));
  assert.deepEqual(calls.chmod[0], { p: plan.scriptPath, m: 0o700 });
});

test('openTerminal spawns the opener detached; null opener → not opened', () => {
  let spawned = null;
  const io = { spawn: (cmd, args, opts) => { spawned = { cmd, args, opts }; return { unref() {} }; } };
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', hasWt: false } });
  assert.deepEqual(openTerminal(plan, io), { opened: true });
  assert.equal(spawned.cmd, 'open');
  assert.equal(spawned.opts.detached, true);

  const none = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'unsupported', hasWt: false } });
  assert.deepEqual(openTerminal(none, io), { opened: false });
});
