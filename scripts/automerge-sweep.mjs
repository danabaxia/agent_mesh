#!/usr/bin/env node
// Thin CLI: wire the real gh + env, run the gated auto-merge sweep. Failure is
// data → always exit 0 (a cron sweep must not fail the workflow on a transient
// gh hiccup). enabled is OFF unless AUTOMERGE_ENABLED === 'true'.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSweep } from '../src/automerge/sweep.js';

const sh = promisify(execFile);
const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;
const repo = process.env.GITHUB_REPOSITORY || process.env.DEV_SOCIETY_REPO || '';

const r = await runSweep({
  gh,
  repo,
  enabled: process.env.AUTOMERGE_ENABLED === 'true',
  dryRun: process.argv.includes('--dry-run'),
  log: (m) => console.error(m),
});
console.error('automerge result: ' + JSON.stringify(r));
