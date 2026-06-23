gle deduped escalation comment (reusing the existing marker/dedup convention).
- **`DEV_MESH_PAT` preflight check** — a cheap authenticated capability probe for spec-branch `contents:write`; fails loud with a clear message on miss.
- **529 handler** — bounded retry-on-529 with jittered back-off and/or neutral-exit mapping; replaces the exit-1 path and the dead action reference.
- **Config** — attempt cap `N` (default 3), retry count/back-off for 529, and any disable flags.

## Data flow

1. `dev-mesh-intake` triggers for an issue.
2. **Preflight (Fix 2):** verify `DEV_MESH_PAT` can write the spec branch. Missing/unauthorized → fail loudly now, stop (no loop). Authorized → continue.
3. The agent authors the spec (ask-only, spec-only).
4. **Agent-step execution (Fix 3):** on transient `HTTP 529`, retry with back-off; if exhausted, exit neutral/soft (no hard red). Non-529 failures behave as before.
5. **Spec push:** before re-authoring on a failed push, the attempt-counter logic (Fix 1) reads prior `"Spec ready attempt N"` signal:
   - attempts `< N` → re-author and increment.
   - attempts `>= N` → **circuit-break**: add `needs-human`, leave one escalation comment, stop.
6. On a **green push**, the counter resets and the credential-issue closing condition (Fix 2) is satisfied — credential issues are closed only here.

## Testing

Pure-logic and workflow-step tests (hermetic):

**Fix 1 — circuit breaker:**
- **Under cap:** 2 prior attempts → re-author (3rd attempt) proceeds.
- **At cap:** 3 prior failed attempts → circuit-break: `needs-human` added, **one** escalation comment, no further re-author.
- **Dedup:** re-running at cap does not add a second escalation comment.
- **Reset on success:** a green push resets the counter; a later attempt starts at 1.
- **Durable count:** attempt count is read from comments/state, not lost on runner restart (no self-reset loop).

**Fix 2 — preflight:**
- **Missing PAT:** preflight fails loudly with the clear message; no downstream push attempt, no loop.
- **Unauthorized PAT:** insufficient `contents:write` for spec branch → preflight fails.
- **Authorized PAT:** preflight passes, workflow continues.
- **Closing criteria:** credential issue is **not** marked closeable until a green push signal exists (assert the closing condition depends on observed push success).
- **Invariant:** preflight checks only spec-branch write for `DEV_MESH_PAT`; no code-build scope probed.

**Fix 3 — 529:**
- **Transient 529 then success:** retry path → run succeeds (no hard red).
- **Persistent 529:** retries exhausted → neutral/soft outcome, not exit-1.
- **Non-529 failure:** still fails as before (529 handling didn't mask real errors).
- **Dead hint removed:** error output no longer references the nonexistent `mesh-retry-backoff`; any hint points to a real path.

## Out of scope

- **Changing intake to do code builds or non-spec work** — intake stays ask-only / spec-only (`contents:read` for `GITHUB_TOKEN`, `DEV_MESH_PAT` for spec branches only).
- **Auto-fixing the underlying spec-authoring failure** — the circuit breaker stops the loop and escalates; it does not diagnose why a spec push fails.
- **Auto-retrying the fix or re-routing** the issue after circuit-break — `needs-human` hands off to a human.
- **Broad 529 handling across all workflows** — this targets `dev-mesh-intake`; a repo-wide 529 helper (cf. idea #386) is a separate effort, though this should reuse it if/when it exists.
- **Provisioning or rotating `DEV_MESH_PAT`** — the preflight *detects* a missing/unauthorized token; obtaining/rotating the credential is operator work.
- **Retroactively reopening prematurely-closed credential issues** (#227/#418/#421) — this prevents recurrence; historical cleanup is separate.
- **Verifying the Claude API 529 contract from first principles** — confirm the distinguishable signal against the live error behavior before relying on selective retry.
- **Path-guard / anti-spoof / single-writable-root changes** — none.
