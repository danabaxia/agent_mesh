# Voice capture — deploy & sync (demo-path productionization)

How spoken ideas get from the voice box to the Mac mesh, durably. The durability
core (outbox · capture-first turn loop · syncer · Mac `/capture`) is on `main`
(PR #592). This doc covers running it end-to-end.

## Pieces

| Component | Where | What |
|---|---|---|
| capture-first turn loop | box (WSL/GPU) | every turn → `outbox` (`state=captured`) **before** STT/LLM (`voice-server/agent.py`) |
| outbox | box | SQLite(WAL) durable store, idempotent on ULID id (`voice-server/outbox.py`) |
| syncer daemon | box | reconcile + interval-drain pending → Mac `/capture` (`voice-server/syncer_daemon.py`) |
| `/capture` sink | Mac | durable-before-200, idempotent on id (`agent-mesh serve-capture`) |

## 1. Mac sink — `serve-capture`

```sh
MAC_CAPTURE_TOKEN=$(openssl rand -hex 16) \
CAPTURE_PORT=8787 CAPTURE_DIR=~/voice-captures \
  node bin/agent-mesh.js serve-capture
```

- Binds `127.0.0.1` by default (plan: tailnet-only). Set `CAPTURE_HOST=0.0.0.0`
  to accept LAN/tailnet sync directly (still bearer-gated).
- Returns `200` only after an `fsync`'d append; a repeat `id` is a `200` no-op
  (idempotent). `401` (bad token) · `400` (schema) · `5xx` (transient → retried).

## 2. Box push — `syncer_daemon`

```sh
MAC_CAPTURE_URL=http://<mac>:8787/capture \
MAC_CAPTURE_TOKEN=<same token> VOICE_DB=/opt/voice/turns.db \
  python3 voice-server/syncer_daemon.py
```

Reconciles crashed `syncing` rows on start, then drains pending every
`SYNC_INTERVAL_S` (5s). Transient failures (offline/5xx/429) stay **pending and
retry forever**; only permanent `4xx` (schema/auth) → `dead`. At-least-once
delivery + id-idempotent store ⇒ exactly-once persistence.

## 3. box → Mac reachability

The box must reach the Mac's `/capture`. Pick what fits the network:

- **Tailscale (recommended for prod):** keep the sink on `127.0.0.1` and
  `tailscale serve` it onto the tailnet; the box posts to the Mac's MagicDNS
  name. No LAN exposure.
- **Direct LAN/tailnet:** `CAPTURE_HOST=0.0.0.0` on the sink, post to the Mac IP.
  Requires the Mac firewall to allow inbound to `node` on the port.
- **Mac-initiated pull (NAT / locked-down Mac firewall):** when the box can't
  reach the Mac inbound, invert it — a Mac-side job SSHes to the box, reads
  pending outbox rows, POSTs them to the Mac loopback sink, and marks them
  synced. Same durability semantics (outbox holds pending; drains when sync
  resumes); only the initiator differs.

## Durability guarantee (verified)

- **Capture-first:** the turn is committed to the outbox before STT/LLM run, so
  an STT or LLM failure never loses the idea (`test_agent_order.py`).
- **Offline survival:** ideas captured while the Mac is unreachable stay
  `pending` and sync when it returns — acceptance run: 3 ideas captured offline →
  all 3 durable on the Mac, nothing lost.
- **Exactly-once:** re-posting the same id is a `200` no-op; no duplicates.

## Not yet (Phase B — LiveKit/PWA)

Continuous WebRTC transport (LiveKit), the phone PWA, room-scoped token mint,
and the spoken next-session notices (`notices(outbox)` is built and ready) land
with the streaming agent. The demo transport (HTTP turn server + push-to-talk
client) already exercises this same capture→outbox→sync pipeline.
