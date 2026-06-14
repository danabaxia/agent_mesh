/**
 * src/dashboard/shell.js
 *
 * Native Claude Code CLI entry point (shell). Builds — and, on launch, opens in
 * the operator's OWN terminal — an interactive `claude` session scoped to an
 * agent folder, mesh-aware (mesh env + assembled MCP set incl. the peer bridge).
 *
 * Security: paths/env reach the generated launch script ONLY through literal
 * encoders (no string interpolation into shell syntax); CR/LF/NUL are rejected.
 * The plan is computed first (no fs side effects) and shown to the operator; the
 * exact same plan is then written (exclusive create, 0700/0600) and opened.
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { existsSync } from 'node:fs';

const BIN_PATH = fileURLToPath(new URL('../../bin/agent-mesh.js', import.meta.url));

// --- literal encoders (no interpolation into shell syntax) ---

export class ShellInputError extends Error {
  constructor(message) { super(message); this.name = 'ShellInputError'; this.code = 'bad_input'; }
}

/** Reject control chars no quoting reliably tames in a one-line script. */
export function assertNoControlChars(value, what = 'value') {
  const s = String(value);
  if (/[\r\n]/.test(s) || s.includes('\u0000')) {
    throw new ShellInputError(`${what} contains a newline or NUL, which is not allowed.`);
  }
}

/** POSIX single-quote encoding: wrap in '…', rewriting each ' as '\''. */
export function encodePosix(value) {
  assertNoControlChars(value, 'path/env');
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * cmd.exe-safe quoting for a `set "K=V"` / `cd "…"` argument. Wrap in double
 * quotes and neutralize the metacharacters `cmd.exe` acts on with a `^` caret.
 * `%` and `!` are the dangerous expanders; we caret-escape and refuse control
 * chars. (Values here are mesh paths/env, not arbitrary user shell.)
 */
export function encodeCmd(value) {
  assertNoControlChars(value, 'path/env');
  const escaped = String(value).replace(/([%!^&|<>"()])/g, '^$1');
  return `"${escaped}"`;
}

/**
 * PowerShell-safe single-quoted literal: inside '…' the only special character
 * is the quote itself, doubled. No variable expansion, no operators.
 */
export function encodePs(value) {
  assertNoControlChars(value, 'path/env');
  return `'${String(value).replace(/'/g, "''")}'`;
}

// --- opener detection (impure, run before the pure builder) ---

/** Is a macOS .app installed (system or user Applications)? */
function defaultAppExists(name) {
  return existsSync(`/Applications/${name}.app`) || existsSync(join(homedir(), 'Applications', `${name}.app`));
}

/**
 * @param {string} platform  process.platform
 * @param {{ which?: (cmd:string)=>boolean, appExists?: (name:string)=>boolean }} [io]  injectable probes
 * @returns {{ kind: 'darwin'|'win32'|'unsupported', macApp?: string, hasWt: boolean }}
 */
export function detectOpener(platform, io = {}) {
  const which = io.which || (() => false);
  const appExists = io.appExists || defaultAppExists;
  if (platform === 'darwin') {
    // Prefer iTerm if installed; fall back to Terminal.
    return { kind: 'darwin', macApp: appExists('iTerm') ? 'iTerm' : 'Terminal', hasWt: false };
  }
  if (platform === 'win32') return { kind: 'win32', hasWt: !!which('wt') };
  return { kind: 'unsupported', hasWt: false };
}

// --- pure plan builder ---

/**
 * @param {object} opts
 *   @param {string} opts.agentRoot
 *   @param {Record<string,string>} opts.env        mesh env to export (values encoded)
 *   @param {string} opts.bridgeConfigPath          path to the generated MCP config
 *   @param {string} opts.tempDir                   the (uncreated) private dir for this launch
 *   @param {{kind:string,hasWt:boolean}} opts.opener  from detectOpener (input, no probing)
 *   @param {string} [opts.resumeId]                 if set, append `--resume <id>`
 *     to the generated `claude` invocation (resume an existing session).
 *   @param {boolean} [opts.continueSession]          if true, append
 *     `--continue` (resume Claude's most recent session in this cwd).
 *   @param {string} [opts.sessionId]                if set, append
 *     `--session-id <id>` (create the first transcript for a reserved canonical
 *     session id). Mutually exclusive with resumeId. The id is run through the
 *     same literal encoder as paths/env (UUID-shaped, but we never trust the
 *     shape — quote it).
 *   @param {string} [opts.skillSettingsPath]        if set, append
 *     `--settings <path>` to add a per-agent skill-restriction settings file.
 *     Native settings sources are disabled below with `--setting-sources ""` so
 *     unrelated operator/project hooks cannot break the mesh terminal launch.
 *     Only set when the agent's skill policy is restrictive (mode !== 'all').
 * @returns {{ command, scriptName, scriptBody, scriptPath, openerArgv: string[]|null }}
 */
export function buildLaunchPlan({ agentRoot, env, bridgeConfigPath, tempDir, opener, resumeId, sessionId, continueSession = false, skillSettingsPath }) {
  assertNoControlChars(agentRoot, 'agentRoot');
  if (resumeId != null) assertNoControlChars(resumeId, 'resumeId');
  if (sessionId != null) assertNoControlChars(sessionId, 'sessionId');
  if (skillSettingsPath != null) assertNoControlChars(skillSettingsPath, 'skillSettingsPath');
  const sessionFlag = claudeSessionFlag(resumeId, sessionId, continueSession);
  const envEntries = Object.entries(env || {});
  for (const [k, v] of envEntries) { assertNoControlChars(k, 'env key'); assertNoControlChars(v, `env ${k}`); }

  if (opener.kind === 'darwin') {
    const scriptName = 'launch.command';
    const scriptPath = join(tempDir, scriptName);
    const sessionArg = sessionFlagArg(sessionFlag, encodePosix);
    const skillArg = skillSettingsPath ? ` --settings ${encodePosix(skillSettingsPath)}` : '';
    const sourceArg = settingsSourceArg(encodePosix);
    const lines = ['#!/bin/sh', `cd ${encodePosix(agentRoot)}`];
    for (const [k, v] of envEntries) lines.push(`export ${k}=${encodePosix(v)}`);
    lines.push(bridgeConfigPath
      ? `exec claude --strict-mcp-config --mcp-config ${encodePosix(bridgeConfigPath)}${sessionArg}${skillArg}${sourceArg}`
      : `exec claude${sessionArg}${skillArg}${sourceArg}`);
    const scriptBody = lines.join('\n') + '\n';
    // Open the script in the chosen terminal app. Important divergence:
    //   • Terminal.app NATIVELY handles `.command` files, so `open -a Terminal …`
    //     opens a window and executes the script.
    //   • iTerm does NOT — `open -a iTerm foo.command` returns exit 0 silently
    //     without running the script. Use AppleScript to create a new iTerm
    //     window that explicitly runs the script as its initial command.
    const macApp = opener.macApp || 'Terminal';
    let openerArgv;
    if (macApp === 'iTerm') {
      const esc = scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      openerArgv = [
        'osascript',
        '-e', 'tell application "iTerm" to activate',
        '-e', `tell application "iTerm" to create window with default profile command "${esc}"`
      ];
    } else {
      openerArgv = ['open', '-a', macApp, scriptPath];
    }
    return { command: posixCommand(agentRoot, envEntries, bridgeConfigPath, sessionFlag, skillSettingsPath), tempDir, scriptName, scriptBody, scriptPath, openerArgv };
  }

  if (opener.kind === 'win32') {
    // PowerShell end-to-end — NO cmd.exe anywhere in the chain. The previous
    // `cmd /c start` + batch-of-set-commands launch was repeatedly blocked by
    // CrowdStrike's behavioral engine (detached cmd chains spawning an exe
    // read as malicious automation; observed live 2026-06-11, 20 blocks).
    const scriptName = 'launch.ps1';
    const scriptPath = join(tempDir, scriptName);
    const sessionArg = sessionFlagArg(sessionFlag, encodePs);
    const skillArg = skillSettingsPath ? ` --settings ${encodePs(skillSettingsPath)}` : '';
    const sourceArg = settingsSourceArg(encodePs);
    const lines = [`Set-Location -LiteralPath ${encodePs(agentRoot)}`];
    for (const [k, v] of envEntries) lines.push(`$env:${k} = ${encodePs(v)}`);
    lines.push(bridgeConfigPath
      ? `claude --strict-mcp-config --mcp-config ${encodePs(bridgeConfigPath)}${sessionArg}${skillArg}${sourceArg}`
      : `claude${sessionArg}${skillArg}${sourceArg}`);
    const scriptBody = lines.join('\r\n') + '\r\n';
    // wt hosts powershell directly; without wt, a DETACHED powershell gets its
    // own console window — no `cmd /c start` trampoline needed.
    // NO `-ExecutionPolicy Bypass`: CrowdStrike kills a node-spawned powershell
    // carrying that flag before the script's first line (no window, no error —
    // isolated live 2026-06-12; the identical detached spawn ran once the flag
    // was dropped). Running a local script via `-File` needs no override on
    // RemoteSigned/Bypass hosts; a Restricted host fails visibly in the opened
    // window rather than silently here.
    const psArgs = ['-NoExit', '-File', scriptPath];
    const openerArgv = opener.hasWt
      ? ['wt', '-d', agentRoot, 'powershell', ...psArgs]
      : ['powershell', ...psArgs];
    return { command: psCommand(agentRoot, envEntries, bridgeConfigPath, sessionFlag, skillSettingsPath), tempDir, scriptName, scriptBody, scriptPath, openerArgv };
  }

  // unsupported → no script/opener; the copyable command (POSIX-style) only.
  return { command: posixCommand(agentRoot, envEntries, bridgeConfigPath, sessionFlag, skillSettingsPath), tempDir, scriptName: null, scriptBody: null, scriptPath: null, openerArgv: null };
}

function claudeSessionFlag(resumeId, sessionId, continueSession) {
  const hasResume = resumeId != null;
  const hasSession = sessionId != null;
  const hasContinue = !!continueSession;
  if ([hasResume, hasSession, hasContinue].filter(Boolean).length > 1) {
    throw new ShellInputError('resumeId, sessionId and continueSession are mutually exclusive.');
  }
  if (hasContinue) return { flag: '--continue', value: null };
  if (hasResume) return { flag: '--resume', value: resumeId };
  if (hasSession) return { flag: '--session-id', value: sessionId };
  return null;
}

function sessionFlagArg(sessionFlag, encode) {
  if (!sessionFlag) return '';
  return sessionFlag.value == null
    ? ` ${sessionFlag.flag}`
    : ` ${sessionFlag.flag} ${encode(sessionFlag.value)}`;
}

function settingsSourceArg(encode) {
  return ` --setting-sources ${encode('')}`;
}

function posixCommand(agentRoot, envEntries, bridgeConfigPath, sessionFlag, skillSettingsPath) {
  const env = envEntries.map(([k, v]) => `${k}=${encodePosix(v)}`).join(' ');
  const sessionArg = sessionFlagArg(sessionFlag, encodePosix);
  const skillArg = skillSettingsPath ? ` --settings ${encodePosix(skillSettingsPath)}` : '';
  const sourceArg = settingsSourceArg(encodePosix);
  const tail = (bridgeConfigPath ? `claude --strict-mcp-config --mcp-config ${encodePosix(bridgeConfigPath)}` : 'claude') + sessionArg + skillArg + sourceArg;
  return `cd ${encodePosix(agentRoot)} && ${env ? env + ' ' : ''}${tail}`;
}
// PowerShell copyable preview (the on-disk script is the authoritative form).
function psCommand(agentRoot, envEntries, bridgeConfigPath, sessionFlag, skillSettingsPath) {
  const sets = envEntries.map(([k, v]) => `$env:${k} = ${encodePs(v)}`).join('; ');
  const sessionArg = sessionFlagArg(sessionFlag, encodePs);
  const skillArg = skillSettingsPath ? ` --settings ${encodePs(skillSettingsPath)}` : '';
  const sourceArg = settingsSourceArg(encodePs);
  const tail = (bridgeConfigPath ? `claude --strict-mcp-config --mcp-config ${encodePs(bridgeConfigPath)}` : 'claude') + sessionArg + skillArg + sourceArg;
  return `Set-Location -LiteralPath ${encodePs(agentRoot)}; ${sets ? sets + '; ' : ''}${tail}`;
}

// --- I/O: write the plan's files and open the terminal (injectable) ---

/** A fresh, uncreated private temp dir path for one launch (created at write time). */
export function newTempDir() {
  const rand = Math.random().toString(16).slice(2, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(tmpdir(), `agent-mesh-shell-${stamp}-${rand}`);
}

/**
 * Create the precomputed dir exclusively and write the MCP config + script.
 * @param {object} plan       from buildLaunchPlan
 * @param {string} bridgeConfigPath
 * @param {string} bridgeConfigBody  JSON string
 * @param {object} io  { mkdir, writeFile, chmod }
 */
export async function writePlanFiles(plan, bridgeConfigPath, bridgeConfigBody, io) {
  const { mkdir, writeFile, chmod } = io;
  const dir = plan.tempDir;
  if (!dir || !plan.scriptPath) throw new Error('no script path to write');
  await mkdir(dir, { recursive: false, mode: 0o700 });               // exclusive: EEXIST surfaces
  // The MCP config is omitted when there's nothing extra to inject (the native
  // session then just loads the agent's own cwd .mcp.json — no duplicates).
  if (bridgeConfigPath && bridgeConfigBody) {
    await writeFile(bridgeConfigPath, bridgeConfigBody, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(plan.scriptPath, plan.scriptBody, { flag: 'wx', mode: 0o600 });
  if (chmod) await chmod(plan.scriptPath, 0o700);                     // executable for the opener
}

/** Spawn the OS terminal opener detached. @param io { spawn } */
export function openTerminal(plan, io) {
  if (!plan.openerArgv) return { opened: false };
  const [cmd, ...args] = plan.openerArgv;
  const child = io.spawn(cmd, args, { detached: true, stdio: 'ignore' });
  if (child && child.unref) child.unref();
  return { opened: true };
}

export { BIN_PATH };
