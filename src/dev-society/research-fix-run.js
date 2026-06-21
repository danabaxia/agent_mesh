// src/dev-society/research-fix-run.js — impure ③b runner. Injected gh + runBuild + buildLockHeld.
// Read-only gh (api user, issue list/view) + the single mutation gh issue comment; runBuild
// owns the worktree/git/pr writes.
import { FIX_MARKER, DIAG_MARKER, planResearchFix, researchFixPrompt } from './research-fix.js';

const authoredByBot = (comments, login, marker) =>
  (Array.isArray(comments) ? comments : []).some(
    (c) => c && typeof c.body === 'string' && c.body.includes(marker) && c.author && c.author.login === login);

const latestBotDiagnosis = (comments, login) => {
  const hits = (Array.isArray(comments) ? comments : []).filter(
    (c) => c && typeof c.body === 'string' && c.body.includes(DIAG_MARKER) && c.author && c.author.login === login);
  return hits.length ? String(hits[hits.length - 1].body) : null;
};

export async function runResearchFix({ gh, runBuild, buildLockHeld, repo, cfg = {}, log = () => {} }) {
  const cap = Number.isInteger(cfg.capPerRun) ? cfg.capPerRun : 1;

  let botLogin = '';
  try { botLogin = String(await gh(['api', 'user', '--jq', '.login'])).trim(); }
  catch (e) { log('botLogin resolve failed: ' + (e?.message || e)); }
  if (!botLogin) return { status: 'fail', error: 'could not resolve bot login (gh api user) — no fix this tick' };

  let issues = [];
  try {
    issues = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'needs-human', '--search', 'sort:created-asc', '--limit', '200', '--json', 'number,body,title']));
  } catch (e) { return { status: 'fail', error: 'needs-human list failed: ' + (e?.message || e) }; }
  if (!Array.isArray(issues)) issues = [];

  const enriched = [];
  for (const iss of issues) {
    try {
      const v = JSON.parse(await gh(['issue', 'view', String(iss.number), '--repo', repo, '--json', 'comments']));
      enriched.push({
        number: iss.number, title: iss.title, body: iss.body,
        diagnosis: latestBotDiagnosis(v.comments, botLogin),
        attempted: authoredByBot(v.comments, botLogin, FIX_MARKER),
      });
    } catch (e) { log(`view #${iss.number} failed: ${e?.message || e}`); }
  }

  const { toFix } = planResearchFix(enriched, { capPerRun: cap });
  if (!toFix.length) return { status: 'ok', output: 'no diagnosed-unattempted escalations' };
  if (buildLockHeld()) { log('build in progress — yielding'); return { status: 'ok', output: 'yield (build in progress)' }; }

  let opened = 0;
  for (const f of toFix) {
    const issue = enriched.find((e) => e.number === f.number) || { number: f.number };
    try {
      const res = await runBuild({ issue, prompt: researchFixPrompt(issue, f.diagnosis), draft: true, holdLabel: 'do-not-merge' });
      if (res && res.opened) {
        const pr = res.prNumber ? `PR #${res.prNumber}` : 'a draft PR';
        await gh(['issue', 'comment', String(f.number), '--repo', repo, '--body',
          `${FIX_MARKER}\n\n🛠 **Draft fix** (do-mode, never auto-merged): ${pr}. Review, un-draft, and merge if good.`]);
        opened += 1;
      } else if (res) {
        await gh(['issue', 'comment', String(f.number), '--repo', repo, '--body',
          `${FIX_MARKER}\n\n🛠 Attempted a research-driven fix but did not open a PR (${res.status || 'no change / suite red'}). Needs a human.\n\n${String(res.summary || '').slice(0, 4000)}`]);
      }
    } catch (e) { log(`research-fix build #${f.number} failed (infra): ${e?.message || e} — no marker, will retry`); }
  }
  return { status: 'ok', output: `draft-fixed ${opened}/${toFix.length}` };
}
