#!/usr/bin/env node
// scripts/daily-report.mjs — the impure outer shell for the Daily Mesh Report.
// Gathers local-log tokens + gh PR/issue activity (+ CI usage in P2), aggregates
// to a DailyReport, renders Markdown, and upserts ONE rolling pinned issue's
// dated comment. The host runs this once a day (see scripts/dev-society-install.sh).
//
//   DEV_SOCIETY_REPO=owner/repo node scripts/daily-report.mjs --post
//   node scripts/daily-report.mjs --date 2026-06-18 --dry-run   # print only
//   node scripts/daily-report.mjs --selftest                    # wiring, no gh
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../src/report/aggregate.js';
import { renderMarkdown, renderModel, dailyMarker, findDatedCommentId } from '../src/report/render.js';
import { readLocalLogs, fetchGhActivity, fetchCiUsage } from '../src/report/sources.js';

const sh = promisify(execFile);
const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const REPO = process.env.DEV_SOCIETY_REPO || '';
const LABEL = process.env.DAILY_REPORT_LABEL || 'mesh:daily-report';
const TITLE = process.env.DAILY_REPORT_TITLE || '📊 Daily Mesh Report';
const logDir = resolve(repoRoot, process.env.AGENT_MESH_LOG_DIR || '.agent-mesh/logs');
// Where the dashboard's Daily tab reads the report from (the same model the issue renders).
const CACHE = process.env.AGENT_MESH_DAILY_REPORT_CACHE || join(repoRoot, '.dev-society', 'daily-report.json');

function writeCache(report) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ ...renderModel(report), generatedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.error('daily-report cache write failed (non-fatal):', e.message);
  }
}

function yesterdayUTC() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function findOrCreateIssue() {
  const found = JSON.parse(await gh(['issue', 'list', '--repo', REPO, '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1']));
  if (found.length) return found[0].number;
  // create the rolling issue once; ensure the label exists first (ignore "already exists")
  await sh('gh', ['label', 'create', LABEL, '--repo', REPO, '--color', 'BFD4F2', '--description', 'Rolling daily mesh report'], { maxBuffer: 1 << 20 }).catch(() => {});
  const out = await gh(['issue', 'create', '--repo', REPO, '--title', TITLE, '--label', LABEL, '--body', 'Rolling daily mesh report. One comment per day.']);
  const m = out.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function upsertComment(issueNumber, date, body) {
  const data = JSON.parse(await gh(['issue', 'view', String(issueNumber), '--repo', REPO, '--json', 'comments']));
  const id = findDatedCommentId((data.comments || []).map((c) => ({ id: c.url, body: c.body })), date);
  // Pass the multiline Markdown body via a temp FILE, never as an inline argv/
  // key=value string — robust to '=', '@', backticks, and newlines in the body.
  const dir = mkdtempSync(join(tmpdir(), 'mesh-report-'));
  try {
    if (id) {
      // gh has no "edit comment by id" for issues; patch via the REST API.
      const m = String(id).match(/#issuecomment-(\d+)/) || String(id).match(/(\d+)$/);
      if (!m) throw new Error(`could not parse comment id from "${id}"`);
      const jsonFile = join(dir, 'patch.json');
      writeFileSync(jsonFile, JSON.stringify({ body }));  // proper JSON encoding of the body field
      await gh(['api', '--method', 'PATCH', `repos/${REPO}/issues/comments/${m[1]}`, '--input', jsonFile]);
      return 'edited';
    }
    const mdFile = join(dir, 'body.md');
    writeFileSync(mdFile, body);
    await gh(['issue', 'comment', String(issueNumber), '--repo', REPO, '--body-file', mdFile]);
    return 'added';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const date = opt('--date', yesterdayUTC());
  if (flag('--selftest')) {
    const report = aggregate({ date, prs: [], openPrs: [], issues: [], openIssues: [], localRecords: [], ciRecords: [] });
    process.stdout.write(renderMarkdown(report) + '\n');
    console.error(`selftest OK — date=${date} logDir=${logDir} marker=${dailyMarker(date)}`);
    return;
  }
  if (!REPO) { console.error('error: DEV_SOCIETY_REPO=owner/repo required'); process.exit(2); }

  const [localRecords, activity] = await Promise.all([
    readLocalLogs({ logDir, date }).catch((e) => { console.error('local logs failed:', e.message); return []; }),
    fetchGhActivity({ gh, repo: REPO }).catch((e) => { console.error('gh activity failed:', e.message); return { prs: [], openPrs: [], issues: [], openIssues: [] }; }),
  ]);
  const ciRecords = await fetchCiUsage({ gh, repo: REPO, date }).catch(() => []);  // empty until P2

  const report = aggregate({ date, ...activity, localRecords, ciRecords });
  const body = renderMarkdown(report);
  writeCache(report);  // feed the dashboard Daily tab (both dry-run and post paths)

  if (flag('--dry-run') || !flag('--post')) { process.stdout.write(body + '\n'); return; }
  const issueNumber = await findOrCreateIssue();
  if (!issueNumber) throw new Error('could not find or create the daily-report issue');
  const action = await upsertComment(issueNumber, date, body);
  console.error(`${action} daily report on issue #${issueNumber} for ${date}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
