rge-audit.js` or alongside `dispatch.js`) — atomic JSONL append + tail-read, rooted at `<mesh-root>/mesh/concierge-audit.jsonl`. Pure-ish I/O wrapper; the unit-test seam for sanitization and trim.
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
