#!/usr/bin/env node
// probe-headroom — REAL-claude verification of the two undocumented assumptions
// behind spec 2026-06-12 §3.4. Run manually; record the PASS/FAIL table in the
// spec §12 review log before implementing Tasks 13-15 (rotation control logic).
//
//   assumption 1 (BLOCKS rotation): a --resume turn's input+cache usage reflects
//     the FULL conversation context (cumulative), not a per-request reset.
//   assumption 2 (gates at-rest surface only): the on-disk transcript's assistant
//     records embed message.usage with the three input fields.
//
// Usage: node scripts/probe-headroom.mjs [--help]   (uses AGENT_MESH_CLAUDE or `claude`)
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnFile } from '../src/process.js';
import { occupancyFromUsage, usageFromTail, encodeProjectDir } from '../src/session-transcripts.js';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'probe-headroom: real-claude check of usage semantics (spec 2026-06-12 §3.4)\n' +
    '  assumption 1: --resume usage is cumulative (BLOCKING for rotation)\n' +
    '  assumption 2: transcript assistant records carry message.usage (at-rest surface)\n' +
    'Run with a working `claude` (or AGENT_MESH_CLAUDE). Exits 1 on any FAIL.\n');
  process.exit(0);
}

async function main() {
  const claude = process.env.AGENT_MESH_CLAUDE || 'claude';
  const cwd = await mkdtemp(join(tmpdir(), 'probe-headroom-'));
  const sid = randomUUID();

  async function turn(args) {
    const res = await spawnFile(claude, ['-p', ...args, '--output-format', 'stream-json', '--verbose'], {
      cwd, env: process.env, timeoutMs: 300_000
    });
    // spawnFile always resolves (never rejects). Log stderr if present for diagnosis.
    if (res.stderr) process.stderr.write(`[claude stderr] ${res.stderr.slice(0, 500)}\n`);
    if (res.code !== 0 && res.code !== null) {
      process.stderr.write(`[probe] turn exited code=${res.code}, timedOut=${res.timedOut}\n`);
    }
    let init = null, usage = null;
    for (const line of String(res.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'system' && msg.subtype === 'init') init = msg.session_id;
        if (msg.type === 'result' && msg.usage) usage = msg.usage;
      } catch { /* non-JSON noise */ }
    }
    return { init, usage, occupancy: occupancyFromUsage(usage) };
  }

  const rows = [];
  process.stdout.write(`probe cwd: ${cwd}\nprobe sid: ${sid}\n\n`);
  process.stdout.write('Running turn 1 (--session-id)...\n');
  const t1 = await turn(['Reply with the single word: ready. Then stop.', '--session-id', sid]);
  rows.push(['turn1 result usage present', t1.usage ? 'PASS' : 'FAIL', JSON.stringify(t1.usage)]);
  rows.push(['turn1 session id matches --session-id', t1.init === sid ? 'PASS' : 'FAIL', `init=${t1.init}`]);

  process.stdout.write('Running turn 2 (--resume)...\n');
  const t2 = await turn(['Reply with the single word: again. Then stop.', '--resume', sid]);
  rows.push(['turn2 (--resume) usage present', t2.usage ? 'PASS' : 'FAIL', JSON.stringify(t2.usage)]);
  const cumulative = t1.occupancy !== null && t2.occupancy !== null && t2.occupancy >= t1.occupancy;
  rows.push(['assumption 1: resume occupancy cumulative (t2 >= t1)', cumulative ? 'PASS' : 'FAIL',
    `t1=${t1.occupancy} t2=${t2.occupancy}`]);

  const projectsDir = join(homedir(), '.claude', 'projects');
  const enc = encodeProjectDir(cwd, process.platform, { projectsDir });
  const transcriptPath = join(projectsDir, enc, `${sid}.jsonl`);
  process.stdout.write(`transcript path: ${transcriptPath}\n`);
  // Diagnostic: list what files exist in the project dir for this cwd
  try {
    const files = await readdir(join(projectsDir, enc));
    process.stdout.write(`project dir contents: ${files.join(', ') || '(empty)'}\n`);
  } catch (e) {
    process.stdout.write(`project dir not found (enc=${enc}): ${e.message}\n`);
    // Try to list ~/.claude/projects to help diagnose encoding mismatches
    try {
      const dirs = await readdir(projectsDir);
      const matching = dirs.filter(d => d.includes('probe-headroom') || d.includes('tmp'));
      process.stdout.write(`~/.claude/projects entries (probe-related): ${matching.slice(0, 5).join(', ') || '(none found)'}\n`);
    } catch { /* ignore */ }
  }
  const fromDisk = await usageFromTail(transcriptPath);
  rows.push(['assumption 2: transcript carries usage', fromDisk ? 'PASS' : 'FAIL',
    fromDisk ? `occupancy=${fromDisk.occupancy}` : 'no assistant usage found']);

  let failed = false;
  process.stdout.write('\nPROBE RESULTS\n');
  for (const [name, verdict, detail] of rows) {
    if (verdict === 'FAIL') failed = true;
    process.stdout.write(`  ${verdict}  ${name}  (${detail})\n`);
  }
  process.stdout.write(failed ? '\nFAIL — record in spec §12; see §3.4 fallbacks.\n' : '\nALL PASS — record in spec §12.\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
