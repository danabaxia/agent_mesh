---
slug: capture-first-voice-pipeline
status: active
provenance: "PR #592 (2026-06-27) — Voice MVP: durability core (outbox · syncer · capture-first invariant · Mac /capture)"
---

# Pattern: Capture-First Turn-Ordering Invariant

## When to apply

When building any pipeline where user input passes through AI stages (STT → LLM →
tool-call) and durability of the raw input must be guaranteed regardless of whether
any AI stage succeeds.

Canonical trigger: a voice pipeline where the owner speaks an idea hands-free while
driving and must never lose it — even if STT crashes, LLM times out, or the model
calls no tool.

## The invariant

**Commit the raw input to durable storage BEFORE any AI processing begins.** AI stages
only *enrich* the committed record; they cannot un-capture it.

```
end-of-turn
  │
  ▼
1. COMMIT to outbox (SQLite WAL)   ← durability point; everything after is optional
  │
  ▼
2. STT → attach transcript         ← if fails: record keeps raw audio; state = captured
  │
  ▼
3. LLM/brain → enrich record       ← if calls no tool / errors: record stays captured
  │
  ▼
4. TTS → reply                     ← latency path, decoupled from durability
  │
  ▼
5. Background syncer → push cold   ← outbound sync, decoupled from the turn
```

## Implementation modules

| Module | Role |
|--------|------|
| `outbox.py` | SQLite(WAL) atomic store, enrichment, crash-recovery reconcile |
| `syncer.py` | transient-pending (retry-forever) vs permanent-dead; idempotent POST |
| `agent.py` | enforces the ordering — capture before STT/LLM calls |
| Node `/capture` | receiving endpoint: validates untrusted data, durable-before-ok, idempotent |

**Key distinction in `syncer.py`**: transient failures (network down) → keep in
`pending`, retry next run. Permanent failures (4xx client error) → move to `dead`.
Never drop silently.

## Failure matrix

| Failure | Outcome |
|---------|---------|
| STT fails | Raw audio preserved; transcript enriched later |
| LLM times out | Record stays `captured`; no reply sent |
| LLM calls no tool | Record stays `captured`; reply still generated from text |
| Syncer offline | Record stays `pending`; next-session notice; synced on reconnect |
| Mac `/capture` unreachable | Retry; idempotent — safe to re-POST same ULID |

## Design rules

1. **No spoken confirmation before the durability commit** — the user should not need
   to wait for an ack tone before the capture is safe.
2. **Syncer is background / decoupled** — never block the turn loop on outbound sync.
3. **ULID for idempotency** — the record id is minted at capture time; every retry
   POSTs the same id so the receiver can deduplicate.
4. **Untrusted data bounds at the receiver** — the `/capture` endpoint truncates fields
   to configured max sizes before writing; never trust the sender's lengths.
5. **Crash-recovery reconcile at startup** — on restart, scan for records stuck in
   `in-flight` → reset to `pending` (the outbox write completed; the POST may not have).

## What to defer

- **LLM-enrichment retries** — v1 captures raw audio and marks `enrichment_pending`;
  a separate offline-enrichment pass is a future phase.
- **Offline capture without cloud LLM** — capture is offline-safe (local SQLite); the
  reply path requires cloud. Document this split explicitly.

## Testing gate

1. Three states must be unit-tested per module: outbox (captured/enriched/synced),
   syncer (pending/dead/idempotent), agent (capture-before-STT ordering).
2. An e2e roundtrip test must span the full cold path (Node `/capture` + Python syncer)
   and assert: stored + synced + idempotent on re-POST.
3. No test may assert on LLM output to gate durability — durability must be observable
   from the outbox state alone.

## Provenance

PR #592 (2026-06-27): voice-server `outbox.py` / `syncer.py` / `agent.py` + Node
`src/voice-capture/`, 21 tests green + e2e roundtrip proof. Design vetted through
codex-spec-review (5 BLOCKER + 7 MAJOR resolved) and notebooklm-research-review
(39 external sources). Spec: `docs/superpowers/specs/2026-06-27-windows-voice-server-design.md`.
