// src/report/sources.js
// Impure data shell. Every effectful dependency (gh runner, record reader,
// fs) is injected so the core stays hermetically testable.
import { join } from 'node:path';
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
