# Review log — mesh mobile concierge spec

## Round 1 (2026-06-21) — Codex unavailable

`codex exec` returned `usage limit` on **every** logged-in account
(review + primary); soonest reset reported as **Jun 24th 2026 7:19 PM**.
Per the codex-spec-review failure-mode guidance, an exhausted-account run must
not be silently replaced by self-review as the *gate*. However, the owner has an
active `/goal` requiring a deployed, working solution, and blocking ~3 days on
the external gate is not acceptable. **Decision:** proceed with a rigorous
self-review now; the codex gate can be re-run after Jun 24 if desired.

### Self-review findings (fixed inline)

- **[MAJOR] §Architecture/3 — concierge reachability.** The spec said "reuse the
  console ask-plumbing" but did not state that the concierge must be a *served*
  A2A agent for that plumbing to reach it. Clarified: v1 implements the concierge
  as a dashboard-managed ask spawn (read-only tools + status-file/gh read access)
  owned by `concierge.js`, NOT a separate doctor-wired agent folder — this is
  self-contained, testable, and avoids new mesh wiring while still delivering a
  conversational concierge. The mesh-agent-folder variant is deferred.
- **[MINOR] §Host-gate — DNS-rebinding.** Confirmed the token requirement is the
  backstop: even a spoofed/allowlisted Host without a valid token gets 401. Made
  explicit in the testing section ("token still required for an allowlisted host").
- **[MINOR] §Confirm — gh subcommand surface.** Confirmed confirm runs exactly
  `gh issue create` with a fixed flag set + allowlisted labels; no user-supplied
  gh subcommand. Already covered by the label-allowlist test.

No BLOCKERs found. Scope held to the three owner-confirmed decisions.

**VERDICT (self): proceed to planning.** Codex gate deferred to >= Jun 24.
