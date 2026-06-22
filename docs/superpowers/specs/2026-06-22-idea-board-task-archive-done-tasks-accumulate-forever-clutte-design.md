# Board task archive — done tasks accumulate forever, clutter active view

**Date:** 2026-06-22
**Status:** Design (pending review)
**Builds on:** the mesh task board ([src/board/*](../../../src/board/), spec 2026-06-15-mesh-task-handoff-design.md) and the A2A Task Board view (spec 2026-06-22-a2a-task-board-view-design.md).

## Problem

The mesh task board stores one JSON file per task under `<mesh-root>/mesh/board/tasks/`. All tasks — regardless of state — live in that flat directory forever. `listTasks()` in `src/board/store.js` reads every `.json` in the directory, so the Task Board view and health triage always scan the full set.

With the orchestrator `board-drive` daemon running every 10 minutes and the concierge `assign_task` available from the phone, this directory grows unbounded. After a few weeks of normal operation: hundreds of `done` task files, every `listTasks()` call reads them all, and the Task Board "Done" column renders a growing tail of stale entries from days or weeks ago.

**Impact:**
- Task Board UX: the Done column becomes a chronological dump, not a meaningful in-flight view.
- Performance: `health-collect.js` and `tasks-model.js` process every task on each request/render.
- Health triage (`triage_logs`): stale-task detection must walk all tasks including archived ones, inflating signal with noise.

## Goal

An **archive sweep** that moves terminal (e.g. `done`) tasks past a configurable age threshold (default 7 days) to `<mesh-root>/mesh/board/archive/YYYY-MM/`. The active `tasks/` directory stays lean. Archived tasks remain on disk for audit but are excluded from the default `listTasks()` call. The daemon schedules the sweep daily. The board store gains an optional `{ includeArchived }` flag for forensic queries.

### Decisions

1. **Archive, never delete.** All completed tasks are preserved on disk for audit; the sweep only *relocates* files from `tasks/` to `archive/YYYY-MM/` (completion month).
2. **Terminal-only.** Only tasks in a terminal state (e.g. `done`) are eligible; in-flight tasks are never moved.
3. **Age-gated.** A configurable threshold (default 7 days since terminal transition) prevents moving tasks that just finished; recent completions stay visible in the Task Board.
4. **Pure planner, thin applier.** The planner is a pure function (input: task list + threshold → archive plan); the applier does the I/O. Follows the existing `atomicWriteFile`/`boardDir` conventions.
5. **Backward-compatible.** Default consumers (`listTasks()`, Task Board, `health-collect.js`, `tasks-model.js`, `triage_logs`) see only the leaner active set automatically; forensic callers opt in with `{ includeArchived: true }`.

### Non-goals

- Deleting tasks — the archive preserves everything.
- Archiving non-terminal stale in-flight tasks (staleness/escalation is a separate concern).
- Compaction/compression of the archive directory.
- Archive retention/purge policy (no eventual deletion in v1).
- A UI for browsing the archive (forensic access is via `includeArchived` at the store/API layer).

## Implementation

### Archive directory layout

```
<mesh-root>/mesh/board/
  tasks/          ← active + recently-completed tasks (default listTasks view)
  archive/
    2026-05/      ← tasks completed in May 2026
    2026-06/      ← tasks completed in June 2026
```

Each archived file has the same JSON format as its source — no schema changes.

### Key components

- **`src/board/store.js` — `listTasks({ includeArchived = false })`**: default reads `tasks/`; with the flag, also reads `archive/**/`. Add an archive-path resolver alongside the existing `boardDir`. Reuse `atomicWriteFile` for the destination write.
- **Daemon hook** — register the daily archive sweep in the dev-society/orchestrator daemon alongside existing scheduled sweeps; no new protocol surface.
- **Config (`src/config.js`)** — `AGENT_MESH_BOARD_ARCHIVE_AGE_MS` (default 7 days) and a disable flag (e.g. `AGENT_MESH_BOARD_ARCHIVE_DISABLED`).
- **Completion-age evaluator (pure)** — given a task record, returns its terminal-transition timestamp (max terminal `history.at`, fallback `created_at`) and age; shared by the planner.

## Data flow

1. Daily, the daemon invokes the archive sweep.
2. The sweep lists active tasks via `listTasks()` (default, `tasks/` only).
3. The pure planner selects tasks that are terminal **and** whose completion age exceeds the threshold, computing each one's `archive/YYYY-MM/` destination from its completion month.
4. The applier, per task: atomically write the file to its archive destination, then remove the original from `tasks/`.
5. `tasks/` now holds only active + recently-completed tasks.
6. Default consumers (`listTasks()`, Task Board, `health-collect.js`, `tasks-model.js`, `triage_logs`) read the leaner active set automatically.
7. Forensic queries pass `{ includeArchived: true }` to additionally read `archive/**/`.

## Testing

Pure-planner and store-level tests (hermetic, temp board dir):

- **Aged done → archived:** a `done` task whose terminal transition is 8 days old (threshold 7) → planned for `archive/<completion-month>/`.
- **Recent done → kept:** a `done` task completed 1 day ago → stays in `tasks/`.
- **Non-terminal never archived:** an `in-progress` task 30 days old → not archived (only terminal states qualify).
- **Bucketing:** destination path uses the **completion** month (`YYYY-MM`), verified against the terminal-transition timestamp, not `created_at` when both exist.
- **Fallback timestamp:** a terminal task lacking terminal `history.at` → completion age computed from `created_at`.
- **Move integrity:** after the sweep, the archived file exists in `archive/` and is absent from `tasks/`; content is byte-identical.
- **Idempotency / crash safety:** re-running the sweep over an already-archived task is a no-op; a simulated interrupt after write-before-delete leaves a recoverable duplicate, never a loss.
- **`listTasks` default excludes archive:** archived tasks do not appear in a default `listTasks()`; UX/health consumers see only active tasks.
- **`includeArchived: true` reads both:** forensic call returns active + archived tasks.
- **Config:** lowering `AGENT_MESH_BOARD_ARCHIVE_AGE_MS` archives more aggressively; disable flag → sweep no-ops.
- **Resilience:** a malformed task file is skipped (not archived, not fatal); missing `archive/` directory is created on first write.

## Out of scope

- **Deleting tasks** — archive preserves everything on disk for audit; no task is ever removed, only relocated.
- **Archiving non-terminal (stale in-flight) tasks** — that is a staleness/escalation concern (idea #219), handled separately; this sweep only moves terminal tasks.
- **Compaction / compression of the archive** (e.g. rolling a month into a single file or gzip) — v1 keeps one file per task; size optimization is deferred.
- **Archive retention/purge policy** — there is no eventual deletion of very old archives in v1.
- **UI for browsing the archive** — the Task Board still shows only active tasks; a dedicated archive-browsing view is a later enhancement (forensic access is via `includeArchived` at the store/API layer).
- **Task schema changes** — archived files are unchanged; no new fields.
- **Changing the board state machine (`task-state.js`)** — untouched.
- **Path-guard / anti-spoof / write-boundary changes** — none; writes stay within the framework-owned `mesh/board/` root via existing atomic-write conventions.
