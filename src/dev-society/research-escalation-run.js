// src/dev-society/research-escalation-run.js — impure orchestration for ③a.
// Injected `gh` (returns stdout string) + `dispatchAnalyst` ({issueNumber,prompt}→{done,text}).
// Read-only gh (api user, issue list/view, pr view/diff) + the single mutation gh issue comment.
import { MARKER, planResearch, buildResearchPrompt } from './research-escalation.js';

const authoredByBot = (comments, botLogin) =>
  (Array.isArray(comments) ? comments : []).some(
    (c) => c && typeof c.body === 'string' && c.body.includes(MARKER)
      && c.author && c.author.login === botLogin,
  );

/** Host-side, read-only context gather (the ask-mode Analyst can't run gh). Best-effort. */
export async function collectContext(gh, repo, f, log = () => {}) {
  const ctx = { issueBody: f.body, prMeta: '', comments: '', diff: '' };
  try {
    ctx.prMeta = String(await gh(['pr', 'view', String(f.prNum), '--repo', repo,
      '--json', 'title,url,mergeStateStatus,statusCheckRollup']));
  } catch (e) { log(`pr view #${f.prNum} failed: ${e?.message || e}`); }
  try {
    const c = JSON.parse(await gh(['pr', 'view', String(f.prNum), '--repo', repo, '--json', 'comments']));
    ctx.comments = (c.comments || []).map((x) => `@${x.author?.login || '?'}: ${x.body || ''}`).join('\n\n');
  } catch (e) { log(`pr comments #${f.prNum} failed: ${e?.message || e}`); }
  try {
    ctx.diff = String(await gh(['pr', 'diff', String(f.prNum), '--repo', repo]));
  } catch (e) { log(`pr diff #${f.prNum} failed: ${e?.message || e}`); }
  return ctx;
}

export async function runResearchEscalation({ gh, dispatchAnalyst, repo, cfg = {}, log = () => {} }) {
  const cap = Number.isInteger(cfg.capPerRun) ? cfg.capPerRun : 2;

  // Resolve bot identity FIRST; fail closed if unknown (else dedup is blind → dup posts).
  let botLogin = '';
  try { botLogin = String(await gh(['api', 'user', '--jq', '.login'])).trim(); }
  catch (e) { log('botLogin resolve failed: ' + (e?.message || e)); }
  if (!botLogin) return { status: 'fail', error: 'could not resolve bot login (gh api user) — no research this tick' };

  // Open needs-human escalations, oldest-first, with headroom.
  let issues = [];
  try {
    issues = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'needs-human', '--search', 'sort:created-asc', '--limit', '200',
      '--json', 'number,body']));
  } catch (e) { return { status: 'fail', error: 'needs-human list failed: ' + (e?.message || e) }; }
  if (!Array.isArray(issues)) issues = [];
  if (issues.length === 200) log('WARN: needs-human backlog hit the 200 fetch cap — oldest still covered (created-asc)');

  // Which are already researched (bot-authored marker only — ignore spoofed markers).
  const researchedNums = new Set();
  for (const iss of issues) {
    try {
      const v = JSON.parse(await gh(['issue', 'view', String(iss.number), '--repo', repo, '--json', 'comments']));
      if (authoredByBot(v.comments, botLogin)) researchedNums.add(iss.number);
    } catch (e) { log(`view #${iss.number} failed: ${e?.message || e}`); }
  }

  const { toResearch } = planResearch(issues, researchedNums, { capPerRun: cap });
  let done = 0;
  for (const f of toResearch) {
    try {
      const ctx = await collectContext(gh, repo, f, log);
      const prompt = buildResearchPrompt(ctx);
      const res = await dispatchAnalyst({ issueNumber: f.number, prompt });
      if (res && res.done && res.text) {
        await gh(['issue', 'comment', String(f.number), '--repo', repo, '--body',
          `${MARKER}\n\n🔬 **Analyst research** (ask):\n\n${String(res.text).slice(0, 60000)}`]);
        done += 1;
      } else {
        log(`#${f.number}: analyst not done/empty — no comment (retried next run)`);
      }
    } catch (e) { log(`research #${f.number} failed: ${e?.message || e}`); }
  }
  return { status: 'ok', output: `researched ${done}/${toResearch.length}` };
}
