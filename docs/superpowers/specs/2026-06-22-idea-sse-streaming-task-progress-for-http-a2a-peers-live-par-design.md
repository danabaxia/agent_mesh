# SSE Streaming Task Progress for HTTP A2A Peers — Design

**Date:** 2026-06-22
**Status:** Design (pending review)
**Builds on:** the HTTP A2A binding (`src/a2a/http-server.js`, spec `serve-a2a-http`) and the delegate pipeline ([src/delegate.js](../../../src/delegate.js)).

## Problem

Long-running delegations to HTTP A2A peers give the caller no signal until the entire `claude -p` run finishes. For delegations that take minutes (large codebases, multi-step do-mode tasks), the caller sees nothing — no indication of progress, no partial output, and no way to show the user live activity. The batch JSON response only arrives when the run exits.

This makes the HTTP transport noticeably worse than a local interactive session: a human watching `claude` in a terminal gets streaming output, but a mesh peer or dashboard waiting on an HTTP peer sits in silence for the full duration.

## Goal

Extend the HTTP A2A binding to **optionally stream task progress as Server-Sent Events (SSE)** when the caller requests it via `Accept: text/event-stream`. The batch path is unchanged for callers that do not opt in. The stream delivers:

- An `in-progress` status event immediately when `claude -p` starts.
- Incremental stdout chunks forwarded as partial events during the run.
- Periodic heartbeat events so the caller's connection does not time out on slow tasks.
- A terminal `TaskCompleted` event (content identical to the batch response) on success; a terminal error event on failure or timeout.

### Non-goals

- Streaming on the stdio transport — `stdio-server.js` stays batch-only.
- Changing the batch wire contract — callers without `Accept: text/event-stream` are unaffected.
- WebSocket transport — SSE only (matching A2A v1.0 and the existing dashboard pattern).
- Caller-side UI work (dashboard/concierge rendering live progress) — server-side delivery only.
- Resumable or replayable streams (`Last-Event-ID` reconnection) — v1 is single-shot.
- Cancellation semantics on caller disconnect — policy is flagged, not settled (see Out of scope).
- Cross-hop streaming propagation (A→B→C live passthrough) — each hop streams its own HTTP response independently.

## Components

- **`src/a2a/http-server.js` (SSE negotiation)** — inspects the incoming `Accept` header after auth. When `text/event-stream` is present and SSE is not disabled, switches the response to `Content-Type: text/event-stream` immediately and starts streaming; otherwise falls through to the existing batch path unchanged.
- **`src/delegate.js` (incremental stdout exposure)** — the spawn pipeline already captures stdout; the SSE path exposes an event emitter or async-iterable over raw stdout chunks in addition to the existing terminal-envelope parse. The batch path is unaffected; no new env or spawn flags.
- **SSE framing helpers** — thin utility (inline or a small `src/a2a/sse.js`) for encoding `data: …\n\n` events, the heartbeat ticker, and the terminal-event shape. No external dependency.
- **Config (`src/config.js`)** — heartbeat interval in milliseconds (`AGENT_MESH_A2A_SSE_HEARTBEAT_MS`) and an optional disable flag forcing batch-only even when `Accept` requests streaming.
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
