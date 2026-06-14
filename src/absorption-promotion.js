// src/absorption-promotion.js — review-gated promotion of digest proposals (spec §9).
// The digest worker (ask-only) only PROPOSES (status pending / drafts). The human
// reviews a diff in the dashboard and approves a subset; THEN the framework — not a
// `do` spawn — writes the approved entries. Because the framework writes directly,
// it must SELF-ENFORCE the boundary the path-guard would otherwise impose:
//   - the model NEVER supplies a path; every target is computed from a fixed prefix
//     (<root>/memory/quick.json, <root>/workflows/<slug>.md);
//   - <slug> is the model's label run through `sanitizeSlug`, which REFUSES any
//     separator / `..` / absolute (a model-chosen `../../other-agent/evil` is
//     refused, not written);
//   - writes are hard-capped (count + field length) and atomic;
//   - only EXPLICITLY APPROVED proposals are written — pending/un-approved ones are
//     skipped with zero writes (the review gate);
//   - promotion writes take a per-agent write lock (SerialQueue) so a concurrent
//     live session / `do` worker can't interleave (spec §9 concurrency).
import { join } from 'node:path';
import { SerialQueue } from './lock.js';
import { atomicWriteFile } from './atomic-write.js';
import {
  readQuickMemory, writeQuickMemory, validateQuickMemory, MAX_FIELD_CHARS
} from './quick-memory.js';

export const MAX_WORKFLOWS_PER_PROMOTION = 10;
export const MAX_WORKFLOW_DRAFT_CHARS = 65_536;

/** A bare, filesystem-safe slug or null. Mirrors recall.js `badIdent` + a charset
 *  whitelist — rejects separators, `..`, absolute paths, control chars, empties. */
export function sanitizeSlug(label) {
  if (typeof label !== 'string') return null;
  const s = label.trim();
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0')) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(s)) return null;          // bare kebab/alnum only
  return s.toLowerCase();
}

const fieldsWithinCap = (e) =>
  Object.entries(MAX_FIELD_CHARS).every(([f, cap]) => typeof e[f] !== 'string' || e[f].length <= cap);

function renderWorkflow(slug, summary, draft) {
  return `# ${slug} (workflow)\n\n${summary || ''}\n\n> Promoted from an absorbed session — review-gated (spec §9).\n\n---\n\n${draft}\n`;
}

/**
 * PURE promotion planner. Given the current store, the proposals, and the set of
 * approved proposal ids, compute the next store + the workflow writes + refusals +
 * skipped — WITHOUT touching the filesystem. Deterministic.
 *
 * proposal (memory):   { id, kind:'memory', key, l0, l1, value, core?, provenance? }
 * proposal (workflow): { id, kind:'workflow', slug, summary, draft }
 *
 * Returns { quickNext, workflowWrites:[{slug,rel,content}], refusals:[{id,reason}], skipped:[id] }.
 */
export function planPromotion(quick, proposals, approvedIds, { now = () => new Date().toISOString() } = {}) {
  const approved = approvedIds instanceof Set ? approvedIds : new Set(approvedIds || []);
  const quickNext = { ...(quick || {}) };
  const workflowWrites = [];
  const refusals = [];
  const skipped = [];

  for (const p of proposals || []) {
    if (!p || !approved.has(p.id)) { if (p) skipped.push(p.id); continue; } // review gate: only approved
    if (p.kind === 'memory') {
      if (typeof p.key !== 'string' || !p.key) { refusals.push({ id: p.id, reason: 'memory key missing' }); continue; }
      const entry = {
        l0: p.l0 ?? '', l1: p.l1 ?? '', value: p.value ?? '',
        core: !!p.core, valid_from: now(), valid_to: null,
        provenance: p.provenance ?? null, status: 'active'
      };
      if (!fieldsWithinCap(entry)) { refusals.push({ id: p.id, reason: 'field exceeds cap' }); continue; }
      quickNext[p.key] = entry;
    } else if (p.kind === 'workflow') {
      const slug = sanitizeSlug(p.slug);
      if (!slug) { refusals.push({ id: p.id, reason: 'unsafe workflow slug' }); continue; }
      if (workflowWrites.length >= MAX_WORKFLOWS_PER_PROMOTION) { refusals.push({ id: p.id, reason: 'workflow count cap' }); continue; }
      if (typeof p.draft !== 'string' || !p.draft.trim() || p.draft.length > MAX_WORKFLOW_DRAFT_CHARS) {
        refusals.push({ id: p.id, reason: 'workflow draft missing or over cap' }); continue;
      }
      workflowWrites.push({ slug, rel: join('workflows', `${slug}.md`), content: renderWorkflow(slug, p.summary, p.draft) });
    } else {
      refusals.push({ id: p.id, reason: `unknown proposal kind "${p.kind}"` });
    }
  }
  return { quickNext, workflowWrites, refusals, skipped };
}

/**
 * Apply an approved promotion under a per-agent write lock. Failure is data:
 * an over-the-global-cap store (validateQuickMemory throws) → { status:'error' }
 * with ZERO writes (fail-closed). `queue` is injectable so callers share one
 * SerialQueue per folder; a fresh one (default) still serializes this call.
 */
export async function applyPromotion({ root, proposals, approvedIds, queue = new SerialQueue(), now }) {
  return queue.run(async () => {
    const quick = await readQuickMemory(root);
    const plan = planPromotion(quick, proposals, approvedIds, now ? { now } : {});
    try { validateQuickMemory(plan.quickNext); }
    catch (e) { return { status: 'error', error: { code: 'cap_exceeded', message: e.message }, refusals: plan.refusals, skipped: plan.skipped }; }

    const wroteMemory = Object.keys(plan.quickNext).filter((k) => !(quick && k in quick) || quick[k] !== plan.quickNext[k]);
    if (wroteMemory.length > 0) await writeQuickMemory(root, plan.quickNext);
    for (const w of plan.workflowWrites) await atomicWriteFile(join(root, w.rel), w.content);

    return {
      status: 'done',
      wrote: { memory: wroteMemory, workflows: plan.workflowWrites.map((w) => w.slug) },
      refusals: plan.refusals,
      skipped: plan.skipped
    };
  });
}
