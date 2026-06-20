// src/mesh-improvement/run.js — host orchestrator: compose pure modules, write
// artifacts, and apply the issue plan via an injected `gh`. Pure compose +
// thin I/O so it is unit-testable with fakes.
import { join } from 'node:path';
import { aggregate } from './aggregate.js';
import { applyBaseline } from './baseline.js';
import { gate } from './policy.js';
import { renderMarkdown } from './render.js';
import { planIssues } from './issues.js';

export function buildReport({ inputs, previousMir, at, ref, noiseBandPct, trendN }) {
  const raw = aggregate(inputs, { at, ref });
  const based = applyBaseline(raw, previousMir, { at, trendN });
  return gate(based, { noiseBandPct });
}

/** Parse the trailing issue number from `gh issue create` URL output. */
function issueNumberFromUrl(out) {
  const m = String(out).trim().match(/\/issues\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function syncReport({ mir, mirDir, dryRun, gh, writeFile, recoverRuns, scanLabel }) {
  const plan = planIssues(mir, { recoverRuns, scanLabel });
  let mutations = 0;

  if (!dryRun) {
    for (const item of plan) {
      if (item.action === 'create') {
        const out = await gh(['issue', 'create', '--title', item.title, '--body', item.body,
          ...item.labels.flatMap((l) => ['--label', l])]);
        const num = issueNumberFromUrl(out);
        if (num && mir.ledger[item.id]) mir.ledger[item.id].issueNumber = num;
        mutations++;
      } else if (item.action === 'update') {
        await gh(['issue', 'comment', String(item.issueNumber), '--body', item.body]);
        mutations++;
      } else if (item.action === 'close') {
        await gh(['issue', 'close', String(item.issueNumber), '--comment', item.body]);
        if (mir.ledger[item.id]) mir.ledger[item.id].issueNumber = null;
        mutations++;
      }
    }
  }

  const day = mir.at.slice(0, 10);
  const jsonPath = join(mirDir, `mir-${day}.json`);
  const mdPath = join(mirDir, `mir-${day}.md`);
  writeFile(jsonPath, JSON.stringify(mir, null, 2));
  writeFile(mdPath, renderMarkdown(mir));
  return { plan, written: [jsonPath, mdPath], mutations };
}
