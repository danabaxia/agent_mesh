#!/usr/bin/env node
// Thin CLI: wire the real gh + env, run the autofix-PR sweep (surface abandoned bug-autofix
// PRs as `blocked` issues for human re-triage). Failure is data → always exit 0 (cron-safe).
// Enabled only when AUTOMERGE_ENABLED === 'true'.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAutofixSweep } from '../src/dev-society/autofix-sweep.js';

const sh = promisify(execFile);
const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;
const repo = process.env.GITHUB_REPOSITORY || process.env.DEV_SOCIETY_REPO || '';

const r = await runAutofixSweep({
  gh,
  repo,
  enabled: process.env.AUTOMERGE_ENABLED === 'true',
  dryRun: process.argv.includes('--dry-run'),
  log: (m) => console.error(m),
});
console.error('autofix-sweep result: ' + JSON.stringify(r));
