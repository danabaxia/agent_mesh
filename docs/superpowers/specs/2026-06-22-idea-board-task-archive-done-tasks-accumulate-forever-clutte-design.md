Tasks({ includeArchived = false })`: default reads `tasks/`; with the flag, also reads `archive/**/`. Add an archive-path resolver alongside the existing `boardDir`. Reuse `atomicWriteFile` for the destination write.
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
