// run-all-tests.mjs — sequential per-file suite runner (Windows-stable):
// each test file gets its own node --test process and a hard timeout, so one
// wedged spawn-heavy file cannot hang the whole run. Prints a final table.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const FILE_TIMEOUT_MS = 240_000;
const files = readdirSync('test').filter((f) => f.endsWith('.test.js')).sort();
const results = [];

for (const f of files) {
  const started = Date.now();
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', `test/${f}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ status: 'TIMEOUT', out }); }, FILE_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code === 0 ? 'PASS' : 'FAIL', out });
    });
  });
  const pass = /# pass (\d+)/.exec(res.out)?.[1] ?? '?';
  const fail = /# fail (\d+)/.exec(res.out)?.[1] ?? '?';
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  results.push({ f, status: res.status, pass, fail, secs });
  console.log(`${res.status.padEnd(8)} ${f.padEnd(40)} pass=${pass} fail=${fail} ${secs}s`);
  if (res.status !== 'PASS') {
    // Red file → dump the failing tests' output so CI logs carry the actual
    // assertions, not just the table (bounded: failing-test sections only).
    const lines = res.out.split('\n');
    const failing = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^not ok /.test(lines[i].trim())) {
        failing.push(...lines.slice(Math.max(0, i - 1), i + 30));
        failing.push('  ---8<---');
      }
    }
    const dump = (failing.length ? failing : lines.slice(-60)).join('\n');
    console.log(`--- ${f} failure output ---\n${dump}\n--- end ${f} ---`);
  }
}

const bad = results.filter((r) => r.status !== 'PASS');
console.log('\n=== SUMMARY ===');
console.log(`files: ${results.length}, green: ${results.length - bad.length}, red: ${bad.length}`);
for (const r of bad) console.log(`  ${r.status} ${r.f} (pass=${r.pass} fail=${r.fail})`);
process.exit(bad.length ? 1 : 0);
