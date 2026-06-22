2A_SSE_HEARTBEAT_MS`) and an optional disable flag forcing batch-only even when `Accept` requests streaming.
- **Caller-side consumers (out of this spec's required scope, noted for integration)** — dashboard/concierge can later read the stream to show live progress; the server side does not depend on them.

## Data flow

1. Caller issues `SendMessage` to an HTTP peer with `Accept: text/event-stream`.
2. `http-server.js` authenticates the request (same gate as all routes).
3. Negotiation: `Accept` includes `text/event-stream` → open SSE response now; else → fall through to batch JSON (unchanged path) and stop here.
4. The binding starts the delegation; `delegate.js` spawns `claude -p` and exposes an incremental stdout stream.
5. On process start → emit `TaskStatusUpdateEvent { state: "in-progress" }`.
6. While running: forward stdout chunks as partial events; emit heartbeat events every N seconds regardless of output.
7. On `claude -p` exit → assemble the full structured result → emit `TaskCompleted` (result identical to batch) → close the stream. On failure/timeout → emit a terminal error event → close.
8. If the caller disconnects mid-stream → the binding cleans up (and, per existing delegation semantics, decides whether to abort or let the run finish — see Out of scope).

## Testing

Hermetic tests with a mock/streamed `claude -p`:

- **Negotiation — SSE:** request with `Accept: text/event-stream` → response is `text/event-stream` and opens before process completion.
- **Negotiation — batch fallback:** request without the header → identical batch JSON to today (regression lock).
- **Event ordering:** stream emits `in-progress` first, then partial chunks in order, then exactly one terminal `TaskCompleted`.
- **Result equivalence:** the `TaskCompleted` payload equals the batch response for the same mocked task (delivery differs, content identical).
- **Partial passthrough:** JSON-lines stdout is forwarded as discrete events; raw text stdout is forwarded as text events.
- **Heartbeat before output:** a process that is silent for > N seconds still produces heartbeat events; assert cadence.
- **Failure path:** a `claude -p` non-zero exit / timeout produces a terminal error event and closes the stream (no silent hang, failure-as-data).
- **Auth:** unauthenticated SSE request is rejected exactly like other HTTP routes.
- **Client disconnect:** caller dropping mid-stream triggers server-side cleanup without leaking the child process per the chosen abort/continue policy.
- **stdio untouched:** stdio transport remains batch-only; no regression and no SSE code path reachable from it.
- **Config:** custom heartbeat interval honored; disable flag forces batch even with the `Accept` header.

## Out of scope

- **Streaming on the stdio transport** (`serve-a2a` / `stdio-server.js`) — stays batch-only.
- **Changing the batch wire contract** — batch callers are unaffected; SSE is purely additive and opt-in.
- **WebSocket transport** — SSE only (matching A2A v1.0 and the existing dashboard pattern); bidirectional/WS streaming is not proposed.
- **Caller-side UI work** — dashboard/concierge consuming the stream to render live progress is a separate follow-on; this spec delivers the server-side stream.
- **Resumable / replayable streams** (e.g. SSE `Last-Event-ID` reconnection mid-task) — v1 is a single-shot stream; reconnection/resume is deferred.
- **Cancellation semantics on disconnect** — whether a caller disconnect *aborts* the running `claude -p` or lets it finish is a policy decision flagged here, not settled by this spec beyond requiring no resource leak.
- **Cross-hop streaming propagation** — forwarding a downstream peer's SSE up through an intermediate hop (A→B→C live passthrough) is not addressed; each hop's HTTP response streams independently.
- **Backpressure tuning / chunk batching strategy** beyond basic passthrough — performance tuning is deferred.
- **Auth or signed-card changes** — reuses the existing HTTP auth gate unchanged.
