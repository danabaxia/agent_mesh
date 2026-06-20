#!/usr/bin/env node
// Thin CLI: wire the real gh + env, run the PR escalation sweep (surface stale-stuck PRs
// as needs-triage issues; self-close when recovered). Failure is data → always exit 0
// (a cron sweep must not fail on a transient gh hiccup). enabled is OFF unless
// AUTOMERGE_ENABLED === 'true'.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runEscalation } from '../src/automerge/escalation-sweep.js';

const sh = promisify(execFile);
const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;
const repo = process.env.GITHUB_REPOSITORY || process.env.DEV_SOCIETY_REPO || '';
const staleMs = Number(process.env.DEV_MESH_PR_STALE_MS || 10800000); // 3h

const r = await runEscalation({
  gh,
  repo,
  enabled: process.env.AUTOMERGE_ENABLED === 'true',
  staleMs,
  dryRun: process.argv.includes('--dry-run'),
  log: (m) => console.error(m),
});
console.error('escalation result: ' + JSON.stringify(r));
