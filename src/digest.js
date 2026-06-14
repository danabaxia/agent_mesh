// src/digest.js — the out-of-band distillation core (spec 2026-06-12 §5).
// The WORKER only emits text (ask-mode, no write tools); THIS module — the
// framework process, i.e. Boundary 5's "separate admin workflow" — validates
// against a fixed contract and applies hard-capped writes. Nothing that is
// obeyed as instructions (skills/workflows/prompts) is ever auto-applied.
// Apply is atomic per FILE, not across files — a crash mid-apply can leave a partial digest (tolerated: rotation never retries an apply, so nothing re-appends; see plan §8).
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { delegateTask } from './delegate.js';
import { resolveTranscript } from './session-transcripts.js';
import { extractForDigest } from './digest-extract.js';
import { extractFirstJson } from './json-extract.js';
import { atomicWriteFile } from './atomic-write.js';
import { isSafeSkillName } from './skills-policy.js';
import {
  readPositiveInt, MAX_MEMORY_FILE_CHARS,
  DEFAULT_DIGEST_TIMEOUT_MS, DEFAULT_DIGEST_EXTRACT_MAX_CHARS
} from './config.js';

const MAX_LEARNED_ITEMS = 20;
const MAX_LEARNED_ITEM_CHARS = 200;
const MAX_DECISION_ITEMS = 10;
const MAX_DECISION_ITEM_CHARS = 200;
const MAX_PROPOSALS = 5;
const MAX_PROPOSAL_SUMMARY_CHARS = 500;
const MAX_PROPOSAL_DRAFT_CHARS = 65_536;

const digestPrompt = (extractRel) =>
  `Read the conversation extract at ${extractRel} (a file in your working directory). ` +
  'Distill it into durable knowledge for future sessions. Reply with ONLY a fenced JSON object:\n' +
  '{ "learned": ["durable fact/preference/constraint, <=200 chars each, max 20 items"],\n' +
  '  "decisions": ["YYYY-MM-DD — one-line self-contained decision, max 10 items"],\n' +
  '  "proposals": [{ "type": "skill" or "workflow", "name": "kebab-case-name", "summary": "one line", "draft": "full draft text" }] }\n' +
  'Use empty arrays for sections with nothing durable. Only include content grounded in the extract.';

/** Fail-closed contract check: ANY invalid entry rejects the whole digest. */
export function validateDigestOutput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  const { learned, decisions, proposals } = parsed;
  if (!Array.isArray(learned) || !Array.isArray(decisions) || !Array.isArray(proposals)) return { ok: false };
  if (learned.length > MAX_LEARNED_ITEMS || decisions.length > MAX_DECISION_ITEMS || proposals.length > MAX_PROPOSALS) return { ok: false };
  const oneLine = (s, cap) => typeof s === 'string' && s.trim() && !s.includes('\n') && s.length <= cap;
  if (!learned.every((s) => oneLine(s, MAX_LEARNED_ITEM_CHARS))) return { ok: false };
  if (!decisions.every((s) => oneLine(s, MAX_DECISION_ITEM_CHARS))) return { ok: false };
  for (const p of proposals) {
    if (!p || typeof p !== 'object') return { ok: false };
    if (p.type !== 'skill' && p.type !== 'workflow') return { ok: false };
    if (!isSafeSkillName(p.name)) return { ok: false };
    if (typeof p.summary !== 'string' || !oneLine(p.summary, MAX_PROPOSAL_SUMMARY_CHARS)) return { ok: false };
    if (typeof p.draft !== 'string' || !p.draft.trim() || p.draft.length > MAX_PROPOSAL_DRAFT_CHARS) return { ok: false };
  }
  return { ok: true, value: { learned, decisions, proposals } };
}

function renderLearned(items, day) {
  const body = `# Learned (digest ${day})\n\n${items.map((s) => `- ${s.trim()}`).join('\n')}\n`;
  if (body.length <= MAX_MEMORY_FILE_CHARS) return body;
  return body.slice(0, MAX_MEMORY_FILE_CHARS - 15).trimEnd() + '\n…[truncated]\n';
}

async function applyDigest(root, sessionId, value, day) {
  const applied = { learned: 0, decisions: 0, proposals: [] };
  if (value.learned.length > 0) { // an EMPTY digest never erases prior memory
    await atomicWriteFile(join(root, 'memory', 'learned.md'), renderLearned(value.learned, day));
    applied.learned = value.learned.length;
  }
  if (value.decisions.length > 0) {
    const path = join(root, 'memory', 'decisions.md');
    const prior = await readFile(path, 'utf8').catch(() => '# Past decisions\n');
    const lines = value.decisions.map((s) => `- ${s.trim()}`).join('\n');
    await atomicWriteFile(path, prior.replace(/\n*$/, '\n') + lines + '\n');
    applied.decisions = value.decisions.length;
  }
  for (const p of value.proposals) {
    const rel = join('deliverables', 'digests', day, sessionId.slice(0, 8), `${p.type}-${p.name}.md`);
    await atomicWriteFile(join(root, rel),
      `# ${p.name} (${p.type} proposal)\n\n${p.summary}\n\n> Digest proposal from session ${sessionId} — propose-only; a human promotes (spec 2026-06-12 §5.3).\n\n---\n\n${p.draft}\n`);
    applied.proposals.push(rel.split('\\').join('/'));
  }
  return applied;
}

/**
 * Distill one session. Failure is data: every non-done outcome returns
 * { status:'error', error:{code,…} } and writes NOTHING.
 * `delegate` is injectable for hermetic tests (defaults to delegateTask).
 */
export async function runDigest({ agentRoot, sessionId, env = {}, io = {}, delegate = delegateTask, now = () => new Date() }) {
  const root = await realpath(agentRoot);
  let transcriptPath;
  try { transcriptPath = await resolveTranscript(root, sessionId, io); }
  catch (e) { return { status: 'error', error: { code: 'transcript_unavailable', message: e.message } }; }

  const extract = await extractForDigest(transcriptPath, {
    maxChars: readPositiveInt(env.AGENT_MESH_DIGEST_EXTRACT_MAX_CHARS, DEFAULT_DIGEST_EXTRACT_MAX_CHARS)
  }).catch(() => '');
  if (!extract.trim()) return { status: 'error', error: { code: 'empty_extract', message: 'nothing to digest' } };

  const extractRel = join('.agent-mesh', 'digest', `${sessionId}-extract.md`);
  await atomicWriteFile(join(root, extractRel), extract);

  const timeoutMs = readPositiveInt(env.AGENT_MESH_DIGEST_TIMEOUT_MS, DEFAULT_DIGEST_TIMEOUT_MS);
  const result = await delegate({
    root,
    env: { ...env, AGENT_MESH_TIMEOUT_MS: String(timeoutMs) },
    input: { mode: 'ask', task: digestPrompt(extractRel) },
    route: 'digest'
  });
  if (result.status !== 'done') {
    return { status: 'error', error: { code: 'digest_worker_failed', message: result.error?.message || result.status, log_path: result.log_path ?? null } };
  }
  const v = validateDigestOutput(extractFirstJson(result.summary || ''));
  if (!v.ok) return { status: 'error', error: { code: 'digest_contract_invalid', message: 'worker output failed the digest contract', log_path: result.log_path ?? null } };

  const day = now().toISOString().slice(0, 10);
  const applied = await applyDigest(root, sessionId, v.value, day);
  return { status: 'done', applied, log_path: result.log_path ?? null };
}
