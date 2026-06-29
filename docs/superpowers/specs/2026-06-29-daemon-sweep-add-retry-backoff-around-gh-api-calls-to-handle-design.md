h` invocation in the daemon sweep/builtin layer: attempt → on failure, classify → retry-with-backoff if transient, else fail immediately → on exhaustion, throw the original error. The single place retry logic lives.
- **Error classifier (pure)** — `(ghError) → { retryable: bool }`: transient network signals → retryable; auth/4xx/validation → not. Pure, table-testable; the correctness seam.
- **Backoff calculator (pure)** — `(attempt) → delayMs` (1s, 5s, 15s); bounded by N.
- **Call-site adoption** — route the affected `gh` calls through the wrapper:
  - `maintainer/label-repair-sweep` (confirmed by #647),
  - `maintainer/issue-sweep` (same surface),
  - other daemon builtins directly invoking `gh issue list` / `edit` / `create`.
- **Config** — retry count and backoff schedule (defaults N=3 / 1s,5s,15s); optional disable flag.

## Data flow

1. A daemon sweep/builtin issues a `gh` call (`issue list` / `edit` / `create`) through the retry wrapper.
2. **Success** → return the result immediately (no behavior change for the common case).
3. **Failure** → the classifier inspects the error:
   - **Non-retryable** (auth / 4xx / validation) → fail immediately with the original error (no wasted retries).
   - **Transient network** → wait the backoff interval and retry, up to N attempts.
4. **A retry succeeds** → return the result; the transient blip was absorbed, no hard failure, no heartbeat escalation.
5. **All N attempts exhausted** → fail with the original error, surfaced to the heartbeat log exactly as today; the heartbeat's N=3-hard-failures escalation logic proceeds unchanged for genuine outages.

## Testing

Pure-classifier and wrapper tests (hermetic, mocked `gh`):

- **Transient then success:** a network error on attempt 1, success on attempt 2 → wrapper returns the result; no hard failure recorded.
- **Persistent transient:** network error on all N attempts → fails with the original error after the full backoff sequence (escalation path intact).
- **Auth error not retried:** a `gh` auth failure → fails immediately, **zero** retries (assert no backoff incurred).
- **4xx not retried:** a 404/403/422 → fails immediately, no retries.
- **Classifier accuracy:** representative transient strings ("error connecting to api.github.com", DNS, timeout, connection refused) → retryable; auth/4xx/validation → not.
- **Backoff schedule:** delays follow 1s, 5s, 15s and stop at N.
- **Escalation preserved:** a sustained outage still produces N=3 hard failures → heartbeat escalates exactly as before.
- **Original-error fidelity:** the error surfaced after exhaustion is the original `gh` error, unchanged.
- **Conservative default:** an unrecognized/ambiguous error is treated as non-retryable (fails fast, not retried).
- **Adoption:** `label-repair-sweep` and `issue-sweep` `gh` calls route through the wrapper.
- **Config:** custom N/backoff honored; disable flag → single-attempt behavior (pre-change).

## Out of scope

- **Changing the heartbeat escalation threshold** — N=3 hard failures still escalate; this only prevents a transient blip from *becoming* a hard failure.
- **Network-level, auth, proxy, or CI-runner network configuration** — this is an application-layer retry, not an infra fix.
- **Retrying non-transient failures** — auth/4xx/validation errors fail fast by design; retrying them is explicitly excluded.
- **Retry for non-daemon `gh` usage** — scoped to daemon sweeps/builtins; other `gh` call sites (e.g. one-shot scripts) are not in scope here, though they could adopt the wrapper later.
- **Idempotency redesign of `gh` operations** — `list`/`edit`/`create` are assumed safe to retry on a *connection* failure (the request likely never reached the API); if a create's idempotency under retry proves risky, that's a follow-on consideration, not addressed here.
- **Jitter / advanced backoff strategies** — fixed exponential schedule in v1.
- **Path-guard / anti-spoof / write-boundary changes** — none; ask-mode `gh` calls with a retry wrapper.
