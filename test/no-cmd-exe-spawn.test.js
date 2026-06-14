// CrowdStrike / EDR guard: cmd.exe enters a Windows process tree three ways —
// (1) spawning with `shell: true`, (2) child_process `exec`/`execSync` (shell-by-
// default → cmd.exe on win32), (3) spawning `cmd.exe` directly. EDR flags the
// `node.exe → cmd.exe` lineage as a living-off-the-land attack pattern, so the
// framework must never introduce it. This guard fails CI if any such pattern
// appears under src/. The ONE sanctioned exception — the rare unparseable-shim
// fallback in src/process.js — is exempted by a `cmd-exe-allow` marker comment.
//
// Scope: src/ JavaScript (the runtime spawn surface). The user-invoked launcher
// scripts (scripts/*.ps1, *.cmd) are out of scope here — a .cmd file is cmd.exe
// by nature; those are vetted by hand (see scripts/start-dashboard.ps1, which
// calls taskkill directly, not via cmd.exe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Return a reason string if the line introduces a cmd.exe spawn, else null.
// `\bexec\b` / `\bexecSync\b` deliberately do NOT match execFile/execFileSync
// (no word boundary after "exec"), which spawn a binary directly — no shell.
function cmdExeRisk(line) {
  const code = line.trim();
  if (code.startsWith('//') || code.startsWith('*')) return null; // comment line
  if (line.includes('cmd-exe-allow')) return null;                // vetted exception
  if (/\bshell\s*:\s*true\b/.test(line)) return 'shell:true spawns via cmd.exe on win32';
  if (/child_process/.test(line) && /\b(exec|execSync)\b/.test(line)) return 'child_process exec/execSync is shell-by-default (cmd.exe on win32) — use execFile/spawn';
  if (/['"]cmd\.exe['"]/i.test(line)) return 'spawns cmd.exe directly';
  return null;
}

test('no cmd.exe-spawning patterns in src/ (CrowdStrike EDR guard)', async () => {
  const files = await jsFiles(SRC);
  const violations = [];
  for (const f of files) {
    const lines = (await readFile(f, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const why = cmdExeRisk(line);
      if (why) violations.push(`${f.replace(SRC, 'src/')}:${i + 1} — ${why}`);
    });
  }
  assert.deepEqual(violations, [],
    `cmd.exe-spawn risk(s) found (mark a vetted, EDR-reviewed exception with a \`// cmd-exe-allow: <reason>\` comment):\n${violations.join('\n')}`);
});

test('the cmd-exe-allow exemption actually works (guard is not vacuous)', () => {
  assert.equal(cmdExeRisk('  return { cmd, args, shell: true }; // cmd-exe-allow: vetted'), null);
  assert.match(cmdExeRisk('  spawn(x, y, { shell: true });') || '', /cmd\.exe/);
  assert.match(cmdExeRisk("  const { exec } = require('node:child_process');") || '', /shell-by-default/);
  assert.equal(cmdExeRisk("  import { execFileSync } from 'node:child_process';"), null); // execFile is safe
  assert.match(cmdExeRisk("  spawn('cmd.exe', ['/c', 'x']);") || '', /directly/);
});
