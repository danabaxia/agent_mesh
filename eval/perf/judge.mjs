// eval/perf/judge.mjs — independent answer-quality judge (spec §7).
// An independent `claude -p` given ONLY { prompt, groundTruth, answer } + a fixed
// rubric — no mesh tools, no registry, low temperature — returns an ordinal score
// 0 / 0.5 / 1. buildJudgePrompt + parseJudgeScore are PURE (hermetically testable);
// runJudge is the impure spawn. Calibration (golden set) is asserted in the
// hermetic suite so judge drift is caught before real runs spend money.
import { spawnFile } from '../../src/process.js';

/** The judge instruction. Independent: it never sees the mesh, only these three. */
export function buildJudgePrompt({ prompt, groundTruth, answer }) {
  return [
    'You are an impartial answer-quality judge. Score ONE answer against a known',
    'ground-truth fact, on this ordinal rubric:',
    '  1   = faithful & complete: conveys the ground-truth fact and does not',
    '        contradict or hallucinate around it.',
    '  0.5 = partial: gestures at the fact but is incomplete or hedged.',
    '  0   = wrong: missing/contradicts the fact, or fabricates an answer.',
    'Judge ONLY faithfulness to the ground truth — not tone or style.',
    '',
    `QUESTION:\n${prompt}`,
    `\nGROUND-TRUTH FACT (the answer should convey this):\n${groundTruth}`,
    `\nANSWER UNDER REVIEW:\n${answer}`,
    '',
    'Reply with a one-line justification, then on the LAST line exactly:',
    'SCORE: <0 | 0.5 | 1>'
  ].join('\n');
}

/** Extract the ordinal score from judge output. Returns 0|0.5|1 or null (fail-closed). */
export function parseJudgeScore(stdout) {
  const text = String(stdout || '');
  // Prefer an explicit "SCORE: x" (last occurrence wins); else a lone trailing token.
  const matches = [...text.matchAll(/SCORE:\s*(0(?:\.5)?|1(?:\.0)?|0\.0)\b/gi)];
  const raw = matches.length ? matches[matches.length - 1][1] : null;
  if (raw == null) return null;
  const n = Number(raw);
  if (n === 0 || n === 1) return n;
  if (n === 0.5) return 0.5;
  return null;
}

/**
 * Spawn the independent judge. Returns { score, raw } — score null on any
 * unparseable/failed output (fail-closed; the caller records it as a null sample).
 * Isolation is structural: NO --mcp-config / --settings / registry, so the judge
 * has no mesh tools and cannot be steered by the mesh — a bare ask.
 */
export async function runJudge({ prompt, groundTruth, answer }, { claude, timeoutMs = 60_000 } = {}) {
  if (!claude) throw new Error('perf judge: a claude binary path is required');
  const judgePrompt = buildJudgePrompt({ prompt, groundTruth, answer });
  let res;
  try {
    res = await spawnFile(claude, ['-p', judgePrompt], {
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, timeoutMs
    });
  } catch (err) {
    return { score: null, raw: `judge spawn failed: ${err.message}` };
  }
  const raw = res.stdout || res.stderr || '';
  return { score: parseJudgeScore(raw), raw };
}
