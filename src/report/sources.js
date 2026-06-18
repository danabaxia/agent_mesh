// src/report/sources.js
// Impure data shell. Every effectful dependency (gh runner, record reader,
// fs) is injected so the core stays hermetically testable.
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readRunLogRecords, dedupeRunRecords } from '../log.js';

export async function readLocalLogs({ logDir, date, prefix = 'delegate', readRecords = readRunLogRecords }) {
  const path = join(logDir, `${prefix}-${date}.jsonl`);
  const records = await readRecords(path);
  return dedupeRunRecords(records);
}

const PR_FIELDS = 'number,title,author,url,createdAt,closedAt,mergedAt';
const ISSUE_FIELDS = 'number,title,labels,url,createdAt,closedAt';
const names = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name));

export async function fetchGhActivity({ gh, repo, lookbackDays = 3 }) {
  const recentPrs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', PR_FIELDS]));
  const openPrs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number']));
  const recentIssues = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', ISSUE_FIELDS]));
  const openIssues = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '300', '--json', 'number,labels']));
  void lookbackDays;
  return {
    prs: recentPrs.map((p) => ({ ...p, author: p.author && p.author.login })),
    openPrs,
    issues: recentIssues.map((i) => ({ ...i, labels: names(i.labels) })),
    openIssues: openIssues.map((i) => ({ ...i, labels: names(i.labels) })),
  };
}

// Default downloader: `gh run download <id> -n mesh-usage-<id>` into a temp dir,
// then read the single JSON file back. Injected in tests.
async function defaultDownload(gh, repo, runId, dir) {
  await gh(['run', 'download', String(runId), '--repo', repo, '--name', `mesh-usage-${runId}`, '--dir', dir]);
  return JSON.parse(readFileSync(join(dir, 'mesh-usage.json'), 'utf8'));
}

export async function fetchCiUsage({ gh, repo, date, download }) {
  const fromMs = Date.parse(`${date}T00:00:00.000Z`);
  const toMs = fromMs + 86400000;
  const runs = JSON.parse(await gh(['run', 'list', '--repo', repo, '--limit', '200', '--json', 'databaseId,workflowName,createdAt']));
  const inWindow = runs.filter((r) => { const t = Date.parse(r.createdAt); return t >= fromMs && t < toMs; });
  const out = [];
  for (const r of inWindow) {
    try {
      const rec = download
        ? await download(`mesh-usage-${r.databaseId}`)
        : await (async () => {
            const dir = mkdtempSync(join(tmpdir(), 'mesh-usage-'));
            try { return await defaultDownload(gh, repo, r.databaseId, dir); }
            finally { rmSync(dir, { recursive: true, force: true }); }
          })();
      out.push({ workflow: r.workflowName, runId: String(r.databaseId), ts: rec.ts || r.createdAt, usage: rec.usage ?? rec });
    } catch {
      out.push({ workflow: r.workflowName, runId: String(r.databaseId), ts: r.createdAt, usage: {}, uncaptured: true });
    }
  }
  return out;
}
