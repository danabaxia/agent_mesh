// src/dashboard/cold-start.js — cold-start session proposals (spec §4/§11). PURE.
// Ties the per-agent manifest (§7) to the copy-paste command builder (§5):
//
//   - OPEN-NEW is the DEFAULT. It mints a FRESH unused UUID and proposes
//     `claude --session-id <new>` (safe per the 2026-06-09 lesson: --session-id
//     only for an id whose transcript does not exist yet).
//   - RESUME is offered ONLY for ids already ACTIVE in the manifest, as
//     `claude --resume <id>` — NEVER `--continue` (a recency heuristic). Archived
//     (retired) sessions are not in the default resume list; a non-UUID/backfill
//     id is silently skipped rather than crashing the list.
//
// The mesh PROPOSES; the user EXECUTES the launch (§4 "Dashboard observes, CLI
// acts"). This module never spawns anything.
import { randomUUID } from 'node:crypto';
import { activeSessionIndex } from '../session-manifest.js';
import { buildResumeCommand } from './resume-command.js';

export function buildColdStartProposals({ manifest, agentRoot, newId = randomUUID(), platform = process.platform }) {
  const openNew = {
    kind: 'open-new',
    session_id: newId,
    ...buildResumeCommand({ agentRoot, sessionId: newId, mode: 'seed', platform })
  };

  const resume = [];
  for (const s of activeSessionIndex(manifest)) {
    try {
      const cmd = buildResumeCommand({ agentRoot, sessionId: s.id, mode: 'resume', platform });
      resume.push({ kind: 'resume', session_id: s.id, l0: s.l0 ?? null, task_label: s.task_label ?? null, ...cmd });
    } catch {
      // non-UUID id (legacy/backfilled session) is not safely resume-proposable — skip it.
    }
  }
  return { openNew, resume };
}
