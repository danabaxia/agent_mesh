ry.
- **Ed25519 primitive wrapper** — thin wrapper over the runtime's crypto for keygen / sign / verify, isolating the algorithm choice.
- **`peer_identity_unverified` Task error** — a structured failure shape carried back through the existing A2A error channel.

## Data flow

**Server (signing), per `initialize`:**
1. `serve-a2a-http` builds its AgentCard.
2. If `AGENT_MESH_SIGNING_KEY_FILE` is set → load private key, canonicalize the attested fields, produce an Ed25519 signature, attach signature (+ optional key id) to the card.
3. Return the (possibly signed) card in the `initialize` response.

**Client (verification), per peer connect:**
1. `HttpClientSession` issues `initialize`, receives the AgentCard (with or without a signature).
2. Look up the peer's `publicKey` in `registry.json`.
3. **No key pinned** → accept the card unverified, continue (backwards-compatible).
4. **Key pinned** → canonicalize the received card's attested fields, verify the signature against the pinned key.
   - Valid → accept as verified; proceed with delegation.
   - Missing or invalid → return a `peer_identity_unverified` Task error; the delegation does not proceed against an unverified peer.
5. The caller (model/orchestrator) sees verification failure as structured data and can react (abort, alert, re-pin).

## Testing

- **Backwards-compat — no key pinned:** unsigned card from an HTTP peer with no `publicKey` in registry → accepted unverified, no error (today's behavior preserved).
- **Happy path — valid signature:** server signs with key K, client pins matching public key → card accepted as verified.
- **Tampered card:** signed card whose `capabilities` (or `name`/`skills`) are mutated in transit before the client verifies → signature fails → `peer_identity_unverified`.
- **Missing signature but key pinned:** peer serves an unsigned card while client has a pinned key → `peer_identity_unverified` (pinning forces a signature).
- **Wrong key pinned:** client pins a public key not matching the server's signing key → `peer_identity_unverified`.
- **Canonicalization determinism:** server-signed bytes and client-verified bytes match across differing field insertion orders / whitespace; round-trip of the canonicalizer is stable.
- **Failure-as-data:** every verification failure returns a structured `peer_identity_unverified` Task error — assert *no* thrown exception escapes `HttpClientSession`.
- **Malformed registry key:** invalid base64url/DER in `publicKey` → surfaced as data at load, does not crash startup.
- **`gen-signing-key`:** produces a usable Ed25519 pair; the emitted public key, pinned in the registry, verifies a card signed by the emitted private key (end-to-end keygen → sign → verify).
- **stdio untouched:** stdio peers ignore signing/verification entirely; no regression on the local-process path.
- **Server opt-out:** `AGENT_MESH_SIGNING_KEY_FILE` unset → unsigned card served, and an unpinned client still connects.

## Out of scope

- **PKI / certificate authorities / trust chains** — pure operator-pinned trust only.
- **Key revocation and rotation workflows** — re-pinning is manual in v1; no revocation list, no automated rotation.
- **Mandatory/global enforcement** — verification is per-peer opt-in via key pinning; there is no mesh-wide "require all peers signed" switch in v1.
- **stdio peer verification** — locally-spawned processes are already under operator control and are explicitly excluded.
- **Signing fields beyond the attested identity/authority set** (`name`, `capabilities`, `skills`) — request/response payload signing or full-session authentication is not addressed here.
- **Transport security (TLS) changes** — this attests *card content*, independent of and complementary to any transport encryption; it is not a replacement for TLS.
- **Algorithm agility** — Ed25519 only in v1; a negotiable suite is a later concern.
- **Key distribution mechanism** — how operators exchange public keys out-of-band is left to operator process.
