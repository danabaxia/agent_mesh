// Phase-1 CLI surface for human + sandbox-Claude unified mesh ops.
// Goal: stop the round-trip ping-pong where I (sandbox) diagnose, ask the
// user to run gh/launchctl, paste output back, etc. Both me and the user
// now invoke the same `agent-mesh` verb. See the rationale in the commit
// that introduced this file.
//
// Phase 1 scope (this file): READ-MOSTLY ops + a single GH write. Deliberately
// minimal — see TODO.md / issue tracker for Phase 2 (workflow run, pr nudge,
// daemon restart-via-sentinel).
//
//   agent-mesh dev-society status [--repo OWNER/REPO]
//   agent-mesh dev-society ledger [--last N] [--repo OWNER/REPO]
//   agent-mesh issue label <num> [--add LABEL]... [--remove LABEL]... [--repo OWNER/REPO]
//
// All commands resolve the mesh root upward from cwd (looking for
// `.dev-society/`); --repo overrides DEV_SOCIETY_REPO env var.
//
// Auth: gh ops shell out to `gh`. `gh auth status` must succeed (the CLI is
// the single source of truth, no custom token handling here).

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const sh = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Walk up from cwd looking for a `.dev-society/` directory. Returns repo root or null. */
function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.dev-society'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Read the last N lines of a file, fast (last-block read; no full slurp for huge logs). */
async function tailLines(path, n) {
  try {
    const data = await readFile(path, 'utf8');
    const lines = data.split('\n');
    // strip trailing empty
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return null;
  }
}

/** Parse a jsonl file into an array of records (skipping malformed lines). */
async function readJsonl(path) {
  try {
    const data = await readFile(path, 'utf8');
    const out = [];
    for (const line of data.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return null;
  }
}

/** Resolve --flag value pairs and --flag=value, plus repeated --add X --add Y. */
function parseArgs(argv, flagSpec) {
  // flagSpec: { name: 'single' | 'multi' | 'bool' }
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      const kind = flagSpec[name];
      if (kind === 'bool') { out[name] = true; continue; }
      if (val === undefined) val = argv[++i];
      if (val === undefined) throw new Error(`--${name} needs a value`);
      if (kind === 'multi') { (out[name] = out[name] || []).push(val); }
      else { out[name] = val; }
    } else {
      positional.push(a);
    }
  }
  return { positional, ...out };
}

/** Spawn gh with args; returns { stdout, stderr, code }. Never throws on non-zero. */
async function gh(args, opts = {}) {
  try {
    const { stdout, stderr } = await sh('gh', args, { maxBuffer: 1 << 24, ...opts });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || err.message || '', code: err.code ?? 1 };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// agent-mesh dev-society status
// ──────────────────────────────────────────────────────────────────────────────

async function statusCmd(parsed, env) {
  const root = findRepoRoot();
  if (!root) {
    process.stderr.write('error: cannot find a `.dev-society/` directory by walking up from cwd\n');
    process.exitCode = 1;
    return;
  }
  const ds = join(root, '.dev-society');
  const ledgerPath = process.env.DEV_SOCIETY_LEDGER || join(ds, 'ledger.jsonl');
  const repo = parsed.repo || env.DEV_SOCIETY_REPO || '';

  process.stdout.write(`# dev-society status\n`);
  process.stdout.write(`mesh root: ${root}\n`);
  process.stdout.write(`repo:      ${repo || '(unset — set DEV_SOCIETY_REPO or pass --repo)'}\n`);
  process.stdout.write(`time:      ${new Date().toISOString()}\n\n`);

  // daemon.log: last 3 + any errors today
  const dlog = await tailLines(join(ds, 'daemon.log'), 5);
  process.stdout.write(`## daemon.log (last 5)\n`);
  if (dlog && dlog.length) for (const l of dlog) process.stdout.write(`  ${l}\n`);
  else process.stdout.write(`  (no daemon.log found)\n`);
  process.stdout.write('\n');

  const elog = await tailLines(join(ds, 'daemon.err.log'), 5);
  process.stdout.write(`## daemon.err.log (last 5)\n`);
  if (elog && elog.length) for (const l of elog) process.stdout.write(`  ${l}\n`);
  else process.stdout.write(`  (no daemon.err.log or empty)\n`);
  process.stdout.write('\n');

  // ledger summary
  const records = await readJsonl(ledgerPath);
  process.stdout.write(`## ledger (last 3 of ${records ? records.length : '?'})\n`);
  if (records && records.length) {
    for (const r of records.slice(-3)) {
      const tests = (r.tests && r.tests.passed === true) ? '✓' : (r.tests && r.tests.passed === false) ? '✗' : '?';
      const edges = (r.edges || []).map((e) => `${e.from}→${e.to}=${e.status}`).join(' ');
      process.stdout.write(`  #${r.issue}  ${(r.ts || '').slice(0, 19)}  pr=${r.pr || '-'}  tests=${tests}  ${edges}\n`);
      process.stdout.write(`    title: ${(r.title || '').slice(0, 90)}\n`);
    }
  } else {
    process.stdout.write(`  (no ledger entries)\n`);
  }
  process.stdout.write('\n');

  // active worktrees
  try {
    const work = await readdir(join(ds, 'work'));
    const dirs = work.filter((d) => d.startsWith('issue-'));
    process.stdout.write(`## active worktrees\n`);
    process.stdout.write(dirs.length ? `  ${dirs.join('  ')}\n` : `  (none — daemon idle)\n`);
  } catch {
    process.stdout.write(`## active worktrees\n  (work/ unreadable)\n`);
  }
  process.stdout.write('\n');

  // queue summary (gh; soft-fail if gh not available)
  if (repo) {
    process.stdout.write(`## queue (gh issue list)\n`);
    const { code, stdout, stderr } = await gh(['issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'approved', '--label', 'route:a2a', '--limit', '30',
      '--json', 'number,title,labels']);
    if (code !== 0) {
      process.stdout.write(`  (gh failed: ${stderr.trim().split('\n')[0].slice(0, 120)})\n`);
    } else {
      try {
        const items = JSON.parse(stdout);
        if (!items.length) process.stdout.write(`  (no approved + route:a2a issues — daemon queue empty)\n`);
        else {
          for (const it of items) {
            const ls = (it.labels || []).map((l) => l.name).join(',');
            const star = ls.includes('in-progress') ? ' ⏳' : ls.includes('blocked') ? ' ⛔' : '';
            process.stdout.write(`  #${it.number}  ${(it.title || '').slice(0, 70)}${star}\n`);
          }
        }
      } catch {
        process.stdout.write(`  (gh stdout unparseable)\n`);
      }
    }
  } else {
    process.stdout.write(`## queue\n  (skipped — no repo configured)\n`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// agent-mesh dev-society ledger
// ──────────────────────────────────────────────────────────────────────────────

async function ledgerCmd(parsed) {
  const root = findRepoRoot();
  if (!root) {
    process.stderr.write('error: cannot find a `.dev-society/` directory by walking up from cwd\n');
    process.exitCode = 1;
    return;
  }
  const ledgerPath = process.env.DEV_SOCIETY_LEDGER || join(root, '.dev-society', 'ledger.jsonl');
  const last = Number(parsed.last) || 10;
  const records = await readJsonl(ledgerPath);
  if (!records) {
    process.stderr.write(`error: cannot read ${ledgerPath}\n`);
    process.exitCode = 1;
    return;
  }
  const take = records.slice(-last);
  process.stdout.write(`# ledger (${take.length} of ${records.length} total)\n\n`);
  for (const r of take) {
    process.stdout.write(`## #${r.issue} — ${(r.title || '').slice(0, 80)}\n`);
    process.stdout.write(`   ts:      ${r.ts}\n`);
    process.stdout.write(`   branch:  ${r.branch || '-'}\n`);
    process.stdout.write(`   pr:      ${r.pr || '-'}\n`);
    if (r.tests) {
      process.stdout.write(`   tests:   ${r.tests.passed === true ? '✓ passed' : '✗ failed'}${r.tests.summary ? ' — ' + r.tests.summary.split('\n')[0].slice(0, 80) : ''}\n`);
    } else {
      process.stdout.write(`   tests:   (not run)\n`);
    }
    for (const e of (r.edges || [])) {
      const m = e.metrics || {};
      const ms = m.worker_run_ms ? ` (${Math.round(m.worker_run_ms)}ms)` : '';
      process.stdout.write(`   ${e.from}→${e.to} ${e.mode}: ${e.status}${ms}\n`);
    }
    process.stdout.write('\n');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// agent-mesh issue label <num> --add X --remove Y
// ──────────────────────────────────────────────────────────────────────────────

async function issueLabelCmd(parsed, env) {
  const [num] = parsed.positional;
  if (!num) {
    process.stderr.write('usage: agent-mesh issue label <num> [--add LABEL]... [--remove LABEL]... [--repo OWNER/REPO]\n');
    process.exitCode = 2;
    return;
  }
  const repo = parsed.repo || env.DEV_SOCIETY_REPO || '';
  if (!repo) {
    process.stderr.write('error: no repo (set DEV_SOCIETY_REPO or pass --repo OWNER/REPO)\n');
    process.exitCode = 2;
    return;
  }
  const adds = parsed.add || [];
  const removes = parsed.remove || [];
  if (!adds.length && !removes.length) {
    process.stderr.write('error: pass at least one --add or --remove\n');
    process.exitCode = 2;
    return;
  }
  const args = ['issue', 'edit', String(num), '--repo', repo];
  for (const l of adds) args.push('--add-label', l);
  for (const l of removes) args.push('--remove-label', l);
  const { code, stdout, stderr } = await gh(args);
  if (code !== 0) {
    process.stderr.write(`gh failed (exit ${code}): ${stderr.trim()}\n`);
    process.exitCode = code;
    return;
  }
  process.stdout.write(stdout || `ok — #${num} labels updated (add=${adds.join(',') || '-'} remove=${removes.join(',') || '-'})\n`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Public entry points called from src/cli.js
// ──────────────────────────────────────────────────────────────────────────────

export async function runDevSocietyCli(argv, env = process.env) {
  const [sub, ...rest] = argv;
  if (sub === 'status') {
    const parsed = parseArgs(rest, { repo: 'single' });
    return statusCmd(parsed, env);
  }
  if (sub === 'ledger') {
    const parsed = parseArgs(rest, { last: 'single', repo: 'single' });
    return ledgerCmd(parsed);
  }
  process.stderr.write([
    'Usage:',
    '  agent-mesh dev-society status [--repo OWNER/REPO]',
    '  agent-mesh dev-society ledger [--last N]',
    '',
  ].join('\n'));
  process.exitCode = 2;
}

export async function runIssueCli(argv, env = process.env) {
  const [sub, ...rest] = argv;
  if (sub === 'label') {
    const parsed = parseArgs(rest, { add: 'multi', remove: 'multi', repo: 'single' });
    return issueLabelCmd(parsed, env);
  }
  process.stderr.write([
    'Usage:',
    '  agent-mesh issue label <num> [--add LABEL]... [--remove LABEL]... [--repo OWNER/REPO]',
    '',
  ].join('\n'));
  process.exitCode = 2;
}
