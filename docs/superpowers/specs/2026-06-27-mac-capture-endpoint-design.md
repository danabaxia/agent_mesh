# Mac `/capture` Endpoint — Normative Contract

Status: draft / design
Date: 2026-06-27
Related: `2026-06-27-windows-voice-server-design.md` (the caller; this is its §10 seam),
`docs/architecture/mesh-agent-notebooklm-source.md` (§1 Mac = state home, §12 R3′ outbox).

## 1. Goal

The **single, normative** sink the Windows voice server calls to durably land a captured idea in the
Mac mesh. It is the *only* cross-machine call in the voice MVP — **no A2A, no delegation**, just an
ask-safe capture endpoint. Its semantics gate the whole "never lose an idea" guarantee, so they are
specified normatively here (the voice spec's acceptance depends on this contract).

## 2. Non-goals

- Not an A2A peer / not the peer-bridge. No `claude -p` spawn. Ask-safe by construction.
- Not a general API — one verb, one shape.
- No dashboard/health channel in MVP (notices surface via the caller's next voice session).

## 3. The contract

```
POST /capture
Host: <mac>.ts.net            # tailnet-only (bind 127.0.0.1 + Tailscale; allowed-host gated)
Authorization: Bearer <token> # MAC_CAPTURE_TOKEN; rotatable
Content-Type: application/json

{ "id": "<ULID>",             # idempotency key (minted by Windows at capture)
  "ts": "<ISO-8601>",
  "text": "<transcript>",     # may be empty if STT failed (audio re-transcribed later)
  "tags": ["..."],            # optional, untrusted
  "title": "<short>",         # optional, untrusted
  "source": "voice" }
```

**Responses:**

| Status | Meaning | Caller (Windows outbox) action |
|---|---|---|
| `200 OK` | Durably stored (or already stored — idempotent) | mark `synced` |
| `400 Bad Request` | Schema invalid / bounds exceeded | **permanent** → `dead` + notice |
| `401/403` | Missing/invalid/expired token | **permanent** → `dead` + notice (rotate token) |
| `429` | Rate-limited | transient → back off, stay `pending` |
| `5xx` / network / timeout | Transient | stay `pending` **indefinitely**, retry |

## 4. Durability (the load-bearing rule)

**`200` is returned ONLY after the idea is durably committed** — written and `fsync`'d to the mesh
board/notes (durable-before-2xx). A crash between receipt and durable write must **not** return
`200`. This is what lets Windows treat `200` as proof and drop its retry.

## 5. Idempotency

Keyed on `id` (ULID from the caller). A duplicate `id`:
- already durably stored → return `200` (no second write);
- in flight → safe to coalesce or return `200` after the first commit.

So at-least-once delivery from Windows (R1′) yields exactly-once storage. (`409` is **not** used —
duplicates resolve to `200` so the caller converges to `synced`.)

## 6. Storage + untrusted-data handling

- Appends to the mesh board (or a `mesh/notes/` store under `<mesh-root>`); the **path-guard
  applies**; ask-safe (no spawn, no execution).
- `text`/`tags`/`title` are **untrusted** (user speech + LLM enrichment): **length-bounded,
  schema-validated, stored quoted as data** (the AGENT.md-as-data invariant — never instructions),
  **rate-limited**, and **audited** (append an audit line per accepted capture).

## 7. Auth + networking

- **Tailnet-only:** bind `127.0.0.1`; expose via Tailscale (the dashboard allowed-host model);
  never public. A **bearer token** (`MAC_CAPTURE_TOKEN`) on every request; **rotatable** (a rotation
  invalidates old tokens → Windows gets `401` → re-mints from `.voice-env`).
- Single caller (the Windows voice server); a tight allow on the tailnet ACL.

## 8. Error handling

Map cleanly to the caller's transient-vs-permanent policy (§3 table). Never return `200` on a
non-durable write. Log rejected payloads (bounded) for audit without storing them as notes.

## 9. Testing

- **Durable-before-2xx:** kill between receive and commit → caller still `pending`, no `200`.
- **Idempotency:** same `id` twice → one stored note, both `200`.
- **Auth:** missing/expired token → `401/403`; post-rotation old token → `401`.
- **Schema/bounds:** oversize/invalid → `400`; caller `dead`.
- **Rate limit:** burst → `429`; caller backs off, stays `pending`.
- **Untrusted data:** injection-shaped `text` stored quoted, never executed; audit line written.

## 10. Build notes

Tiny, ask-safe, zero-dep-style (fits the repo's Node `--test` posture). Lives Mac-side under the
mesh dashboard/server surface or as a small dedicated service; reuses the existing path-guard +
allowed-host + token patterns. Build after the Windows outbox so the contract is exercised end-to-end
by the acceptance demo (voice spec §16).
