# Concierge Dispatch Audit Log — tap-gated actions have no persistent record

**Date:** 2026-06-22
**Status:** Draft (idea → spec)
**Closes:** #397
**Builds on:** the concierge agent and dispatch system ([src/concierge/dispatch.js](../../../src/concierge/dispatch.js), spec 2026-06-21-mesh-mobile-concierge-design.md).

## Problem

The concierge `dispatch.js` handles three Confirm-gated actions: `file_issue`, `assign_task`,
and `ask_peer_rerun`. Each fires, returns a result (issue URL, task id, or ask summary), and
the framework logs nothing persistently.

The owner taps Confirm on the phone, the action fires, the response appears in the chat — and
that is the entire record. There is no searchable history of:

- Which issues were filed via the concierge (vs. manually)
- Which board tasks were assigned (and to whom, with what objective)
- Which peer reruns were triggered (ask payloads, peer responses)

This makes debugging and retrospectives difficult: "what did I ask the mesh to work on last
Tuesday?" has no answer without trawling the concierge's Claude session transcript.

## Goal

An **append-only audit log** at `<mesh-root>/mesh/concierge-audit.jsonl` (one JSON line per
confirmed dispatch). Each entry: `timestamp`, `action`, `payload` (sanitized), `result`
(URL / task_id / summary), `session_id` (present when the dispatch carries a chat session id,
absent otherwise — see §Entry shape). Written by `dispatchAction` on success, off the response
path (append failure → warning, not a dispatch failure). Surfaced via a token-gated
`GET /api/concierge/audit` endpoint and a small **Dispatch History** view in the mobile PWA.
Read-only surface, no mutation.

### Non-goals (YAGNI)

- No logging of failed or cancelled dispatches (v1 records confirmed, successful actions only).
- No edit / delete / replay of audit entries.
- No chat-history unification — this is the *action* log, distinct from concierge *conversation* history (idea #362).
- No advanced search, date-range filters, or cursor pagination — v1 is last-N newest-first.
- No per-identity scoping (single concierge owner model assumed).
- No cross-surface unification with manually-filed issues or pipeline actions.
- No new write tools, Bash, or path-guard changes — append is `writeFile`-style only.

## Architecture

```
Owner taps Confirm (PWA)
       │  dispatchAction(action, payload)   [src/concierge/dispatch.js]
       ▼
  action executes (file_issue / assign_task / ask_peer_rerun)
       │  on success → buildEntry(action, payload, result, sessionId?)
       ▼
  sanitize(payload)   [pure: (action, payload) → sanitizedPayload]
       │
       ▼
  appendEntry(entry)  [src/concierge/concierge-audit.js — atomic JSONL append]
       │              (off response path; failure → warn, not dispatch failure)
       ▼
  <mesh-root>/mesh/concierge-audit.jsonl

Later:
  GET /api/concierge/audit?limit=N  (token-gated, like /api/board/tasks)
       │  tail-read last N lines, skip malformed, return newest-first
       ▼
  PWA Dispatch History view
```

## Entry shape

```json
{
  "timestamp": "2026-06-22T11:00:00.000Z",
  "action": "file_issue",
  "payload": { "title": "...", "body": "..." },
  "result": { "url": "https://github.com/..." },
  "session_id": "abc123"
}
```

`session_id` is present when the concierge `dispatchAction` call carries a chat session id
(the A2A task id of the broker conversation that triggered the dispatch); it is absent
(`undefined`, omitted from JSON) when the dispatch is triggered outside a named session.

## Payload sanitizer

The sanitizer is a **pure function** `sanitize(action, payload) → sanitizedPayload` with
per-action rules:

| Action | Fields preserved | Fields stripped / bounded |
|---|---|---|
| `file_issue` | `title`, `labels` | `body` bounded to 2 000 chars; any key matching `/token|secret|key|auth|pass/i` stripped |
| `assign_task` | `to`, `brief` | `brief` bounded to 500 chars; secret-pattern keys stripped |
| `ask_peer_rerun` | `peer`, `mode` | `task` bounded to 1 000 chars; secret-pattern keys stripped |

Secret-pattern matching applies to all actions as a backstop: any top-level payload key
matching `/token|secret|key|auth|pass/i` is replaced with `"[redacted]"`. This is in addition
to per-action field bounds above.

## Implementation plan

- **`src/concierge/concierge-audit.js`** (new module, either standalone or alongside `dispatch.js`) — atomic JSONL append + tail-read, rooted at `<mesh-root>/mesh/concierge-audit.jsonl`. Pure-ish I/O wrapper; the unit-test seam for sanitization and trim.
- **`dispatch.js`** — on each successful `dispatchAction`, build the sanitized entry and append it. The only new behavior in the dispatch path.
- **Payload sanitizer (pure)** — `(action, payload) → sanitizedPayload`; strips secrets/tokens, bounds large fields (e.g. long ask text), per-action shaping. Pure and table-testable.
- **`src/dashboard/server.js`** — new token-gated `GET /api/concierge/audit?limit=N` route reusing the existing auth gate and tail-read helper.
- **`src/dashboard/public/mobile/`** — Dispatch History view: fetch audit on load, render read-only list.
- **`src/config.js`** — `AGENT_MESH_CONCIERGE_AUDIT_MAX` (optional max entry count for trim; default e.g. 500) and any disable flag.

## Data flow

1. Owner taps **Confirm** on a gated action in the PWA.
2. `dispatchAction` executes the action (`file_issue` / `assign_task` / `ask_peer_rerun`) and obtains its result.
3. On success, `dispatch.js` builds an entry `{ timestamp, action, sanitized payload, result, session_id? }`.
4. The audit store **atomically appends** the entry as one line to `mesh/concierge-audit.jsonl` (off the response path; append failure → warning, not a dispatch failure). If a max is configured, trim oldest lines.
5. The dispatch result returns to the chat as today (unchanged UX).
6. Later, the PWA Dispatch History view calls `GET /api/concierge/audit?limit=N`; the token-gated route tail-reads the last N entries (skipping any malformed line) and returns them newest-first.
7. The owner browses a persistent, searchable record of every confirmed concierge action.

## Trim atomicity and concurrent-append safety

When `AGENT_MESH_CONCIERGE_AUDIT_MAX` is set and the entry count would exceed it, the trim
operation removes the oldest lines. Because JSONL has no in-place delete, this requires
**reading the file, dropping the head, and rewriting it** — a non-atomic operation. The
implementation must:

1. **Hold an exclusive file lock** (e.g. a `.lock` sidecar or `fs.open` O_EXCL) for the
   duration of the read-drop-rewrite to prevent a concurrent append interleaving with the trim.
2. Treat trim as **best-effort**: a failure to acquire the lock → skip trim this cycle (the
   file grows past the cap temporarily); a file-write error during trim → log a warning and
   leave the original untouched. Neither case fails the dispatch.
3. Regular appends (no trim needed) use `fs.appendFile`, which is atomic at the OS level for
   single-writer use; the trim lock protects the rewrite path only.

## Testing

Hermetic, zero-dep tests:

- **Append on success:** each of `file_issue` / `assign_task` / `ask_peer_rerun` succeeding → exactly one correctly-shaped line appended.
- **No log on failure/cancel:** a dispatch that errors or isn't confirmed → no audit entry.
- **Sanitization:** a payload containing a token/secret-like field → that field is stripped/redacted in the stored entry; intent fields are preserved.
- **Result capture:** issue URL, task id (+assignee), and bounded peer summary land in `result` for their respective actions.
- **Append non-blocking / resilient:** a simulated append failure logs a warning and does **not** alter or fail the returned dispatch result.
- **GET history:** returns the last N entries newest-first; `limit` honored; default applied when absent.
- **Auth gate:** unauthenticated `GET /api/concierge/audit` is rejected like other board/health routes.
- **Tolerant read:** a malformed/partial line in the JSONL is skipped, others returned, no throw.
- **Trim (if configured):** appending past `AGENT_MESH_CONCIERGE_AUDIT_MAX` drops oldest lines and keeps the cap.

## Out of scope

- **Logging failed/cancelled dispatches** — v1 records confirmed, successful actions only; failure logging is a separate concern.
- **Mutation surface** — no edit/delete/replay of audit entries; read-only endpoint and view only.
- **Conversation history** — this is the *action* audit log, distinct from any concierge *chat* history (e.g. idea #362); the two are separate files with separate purposes.
- **Per-identity scoping** — assumes the single concierge owner model; multi-user partitioning of the audit log is deferred.
- **Advanced search / filtering / pagination** — v1 is last-N newest-first; full-text search, date-range filters, and cursor pagination are later.
- **Cross-surface unification** — folding manually-filed issues or pipeline actions into the same log is out of scope; this records concierge-gated dispatches only.
- **Export / retention policy beyond a simple max-count trim** — archival, rotation, or compliance retention are not addressed.
- **New write tools or shell spawns** — only `readFile`/`writeFile`-style append; no path-guard, anti-spoof, or write-boundary changes.
