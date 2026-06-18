#!/usr/bin/env node
// Safe local repo updater for the dev-society host checkout.
// It fast-forwards only when the current branch is clean and behind its upstream.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { runRepoSyncOnce } from '../src/dev-society/repo-sync.js';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoPath = process.env.DEV_SOCIETY_SYNC_REPO_PATH || repoRoot;
const logPath = process.env.DEV_SOCIETY_SYNC_LOG || join(repoPath, '.dev-society', 'repo-sync.log');
const ignorePrefixes = (process.env.DEV_SOCIETY_SYNC_IGNORE_PREFIXES || '.dev-society/')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function writeLog(record) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + '\n');
  console.log(new Date().toISOString(), record.action, record.branch || '', record.upstream || '', `ahead=${record.ahead ?? ''}`, `behind=${record.behind ?? ''}`);
}

try {
  await runRepoSyncOnce({ repoPath, ignorePrefixes, log: writeLog });
} catch (error) {
  writeLog({ ts: new Date().toISOString(), action: 'error', repoPath, error: error?.message || String(error) });
  process.exitCode = 1;
}
