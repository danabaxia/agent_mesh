# Mesh Mobile Concierge — private phone front-door

**Date:** 2026-06-21
**Status:** Design (pending review)
**Spec owner:** mobile-concierge feature

## Problem

The mesh already deploys, runs, and evolves locally on the Mac: the `dev-society`
launchd daemon ([scripts/dev-society-daemon.mjs](../../../scripts/dev-society-daemon.mjs))
runs the full `idea → spec → build → PR → merge` pipeline 24/7, the deploy-sync job
([scripts/dev-society-deploy-sync.mjs](../../../scripts/dev-society-deploy-sync.mjs))
hard-resets the deploy worktree to `origin/main` and restarts the dashboard on advance,
and the dashboard ([src/dashboard/server.js](../../../src/dashboard/server.js)) serves
status on `127.0.0.1:7077`.

What is missing is **the phone**. The owner wants to, from their phone:

1. **Discuss ideas** with the mesh (a conversation, not a one-shot form).
2. **Deliver instructions** that land in the existing evolve pipeline.
3. **Review status** of what the mesh is doing.

Today the dashboard is desktop-only, bound to `127.0.0.1` behind a same-origin gate
(hostname must be `127.0.0.1`/`localhost`), and the only way to inject an idea is a
GitHub issue authored by hand. There is no private remote reach and no conversational
intake.

## Goal

Add a **private mobile layer in front of the existing mesh** — reachable from the
owner's phone over Tailscale (no public exposure), where they discuss ideas with a
*concierge agent*, tap to land agreed ideas into the existing pipeline, and review
live status. **No mesh internals change.** The daemon, evolve pipeline, path-guard,
recursion guard, and status surfaces are reused as-is.

### Non-goals (YAGNI for v1)

- No native iOS/Android app — a responsive PWA in the phone browser.
- No public URL, no ngrok/Cloudflare — Tailscale-private only.
- No push notifications — status is pull/poll in v1.
- No new write capability for agents — issue creation stays human-tap-gated.

## Decisions (owner-confirmed)

1. **Remote access: Tailscale (private).** Mac and phone join the same tailnet;
   `tailscale serve` proxies the tailnet to `localhost:7077`. No socket is opened on
   the LAN or internet. Matches the repo's security-first ethos; already suggested in
   [dev-mesh/DEPLOY-A2A-SOCIETY.md](../../../dev-mesh/DEPLOY-A2A-SOCIETY.md).
2. **Interaction: conversational concierge agent.** A chat where the owner discusses
   ideas, delivers instructions, and asks for status in natural language.
3. **Landing: human-tap-gated.** The concierge *proposes*; nothing enters the pipeline
   until the owner taps **Confirm** on the phone. The owner is always the gate.

## Architecture

Five components. Four reuse existing surfaces; only the host-gate change touches a
security boundary.

```
 Phone browser (PWA)
        │  https  (MagicDNS host)
        ▼
 ┌──────────────────┐   tailscale serve   ┌────────────────────────────┐
 │ Tailscale (phone)│ ──────────────────► │ Tailscale (Mac) → :7077    │
 └──────────────────┘   private tailnet   └──────────────┬─────────────┘
                                                          │ localhost
                                                          ▼
                                          ┌────────────────────────────┐
                                          │ dashboard server (:7077)   │
                                          │  • host-gate allowlist     │
                                          │  • /m  mobile PWA          │
                                          │  • /api/concierge/message  │ ask
                                          │  • /api/concierge/confirm  │ write (tap)
                                          │  • existing /api/* status  │ read
                                          └───────┬─────────────┬──────┘
                                                  │ ask          │ gh issue create
                                                  ▼              ▼  (on Confirm only)
                                       ┌────────────────┐   ┌─────────────────────┐
                                       │ concierge agent│   │ GitHub issue (idea / │
                                       │ (ask-only)     │   │ approved+route:a2a)  │
                                       └────────────────┘   └──────────┬──────────┘
                                                                       ▼
                                                          existing dev-society daemon
                                                          → Coder/Reviewer → PR → merge
```

### 1. Private transport — Tailscale (no new LAN socket)

The dashboard keeps binding to `127.0.0.1:7077` (unchanged — line ~2916 of
server.js). `tailscale serve --bg --https=443 127.0.0.1:7077` terminates TLS on the
tailnet and proxies to localhost. **No socket is opened on `0.0.0.0`.** Security =
Tailscale device identity (only the owner's enrolled devices reach the tailnet) + the
existing dashboard token.

A helper `scripts/mesh-mobile-serve.mjs`:
- Detects `tailscale` (errors with install/login instructions if absent).
- Runs `tailscale serve` for `:7077`.
- Prints the MagicDNS URL **and** a one-time token bootstrap link
  (`https://<magicdns>/m?t=<token>`) to open once on the phone.
- Is idempotent (re-running re-prints the URL without stacking serves).

The owner must install Tailscale on Mac + phone and `tailscale up` once
(interactive login — outside automation). Everything else works the moment that
login completes.

### 2. Host-gate allowlist — `src/dashboard/server.js`

`passesSameOriginGate` (lines 324–360) hard-rejects any hostname ≠
`127.0.0.1`/`localhost`. Extend it to also accept hostnames on an **allowlist**:

- Source: `AGENT_MESH_DASHBOARD_ALLOWED_HOSTS` (comma-separated), and/or
  auto-detected MagicDNS name from `tailscale status --json` (`Self.DNSName`,
  trailing dot stripped) when the helper starts the server.
- The allowlist matches **only** `*.ts.net` MagicDNS names or values explicitly
  listed in the env var — never a wildcard, never `0.0.0.0`.
- **Port check** is relaxed for proxied (allowlisted) hosts: Tailscale serves on
  443, so the Host header carries no port (or `:443`); for an allowlisted host we
  accept the absent/`443` port. `127.0.0.1`/`localhost` keep the strict
  listener-port check.
- The **Origin fallback** also accepts `https://<allowlisted-host>`.
- The **token requirement is unchanged** — every gated route still requires the
  cookie/`?t=` token. The allowlist only widens *which Host header* is acceptable;
  it does not remove auth.

This is the only change to a security boundary and is the focus of review + tests.

### 3. Concierge agent — a new mesh agent folder (ask-only, peered)

A real mesh agent folder (e.g. `dev-mesh/agents/concierge/`) wired by `doctor` like
every other agent: `AGENT.md` (its persona/role, treated as untrusted data per the
existing invariant), a marker-validated `registry.json` (so it gets the peer bridge),
and the mesh-health read MCP. It runs **ask-mode only** — read tools + the ask-only
peer bridge + mesh-health read verbs. It **cannot write the repo.**

Its job per turn:
- Converse about an idea / instruction / status question.
- Read status when asked: mesh-health read verbs (`check_conformance`/`triage_logs`)
  and the status JSONs (`daily-report.json`, `heartbeat.json`, recent
  `activity-*.jsonl`), plus the GitHub backlog via the gh-activity cache.
- When discussion converges, emit a **structured draft proposal** in its reply:
  a fenced ` ```concierge-proposal ` JSON block `{title, body, labels[]}`. This is a
  *proposal*, surfaced for the owner to review — never an action.

The dashboard talks to it via the existing console ask-plumbing
([src/dashboard/console.js](../../../src/dashboard/console.js)), which already does an
ask-only A2A delegate to a served agent. We reuse that path rather than inventing a
new spawn.

### 4. Mobile PWA — `src/dashboard/public/mobile/`

A responsive, touch-first single page served at `/m`, with a web-app manifest so it
can be added to the home screen. Two views:

- **Chat**: message thread with the concierge. Owner messages → `POST
  /api/concierge/message`. A reply containing a `concierge-proposal` block renders as
  a **proposal card** (title, body preview, target labels) with a **Confirm** button
  and a label toggle (`idea` only, vs `approved`+`route:a2a` to release straight to
  build).
- **Status**: live cards reusing existing read endpoints — in-flight builds /
  dispatch state, the daily report (`/api/daily`), health (`/api/health`), and recent
  activity (`/api/activity-log`). Pull-to-refresh; no new backend data needed.

Zero build step (matches repo convention: static HTML/CSS/vanilla JS, same as the
existing dashboard public assets).

### 5. Confirm-to-file — `src/dashboard/concierge.js`

The **single write surface**, firing **only** on an explicit Confirm POST:

- `POST /api/concierge/message` → runs one concierge ask turn (via console
  plumbing), returns `{reply, proposal?}`. **Never writes anything.**
- `POST /api/concierge/confirm` → body `{title, body, labels[]}` echoed from a
  proposal the user reviewed. Validates labels against an allowlist
  (`idea`, `approved`, `route:a2a` only), runs `gh issue create` (framework-side,
  using the repo's existing gh auth), returns the new issue URL. This is the moment
  an idea enters the existing pipeline — and it is gated on the owner's tap.

## Data flow (end to end)

1. Owner opens `https://<magicdns>/m` on phone (over Tailscale), authenticated by the
   one-time token (then cookie).
2. Owner chats; concierge reads status / discusses; converges on a proposal.
3. Proposal card appears. Owner edits labels if desired and taps **Confirm**.
4. `POST /api/concierge/confirm` → `gh issue create` → issue enters backlog.
5. Existing `dev-society` daemon picks up `approved`+`route:a2a` → Coder (do) → tests
   → Reviewer (ask) → PR → automerge → `main` advances.
6. deploy-sync pulls `main`, restarts dashboard → the mobile layer's own changes also
   ship this way.
7. Owner reviews progress in the Status view and by asking the concierge.

## Error handling

- Concierge ask timeout/refused/error → returned as a chat error bubble; **no**
  proposal, **no** write. Failure is data (existing invariant).
- `gh issue create` failure → `4xx/5xx` with the stderr surfaced; the card shows a
  retry; nothing silently lost.
- Tailscale not installed / not `up` → helper detects and prints exact remediation.
- Missing/invalid token → `401`; recover via the one-time `/m?t=<token>` link.
- Invalid/unknown label in a confirm body → rejected before any `gh` call.

## Security invariants (all preserved)

- **Concierge is ask-only** — zero repo writes. The only write is `gh issue create`,
  performed framework-side and **only** on the owner's Confirm tap.
- **No public exposure** — bind stays `127.0.0.1`; Tailscale provides private
  transport + device identity; the host-gate is an explicit allowlist (`*.ts.net` /
  env-listed only), and the **token is still required on every gated route**.
- **`AGENT.md` stays untrusted data** — the concierge's AGENT.md is length-bounded
  and framed as data, never executed (existing invariant).
- **Label allowlist** — confirm can only apply `idea`/`approved`/`route:a2a`; it
  cannot set arbitrary labels or run arbitrary `gh` subcommands.
- Path-guard, recursion guard, single-writable-root, anti-spoof delegate surface —
  untouched.

## Testing

Hermetic, zero-dep (`node --test`), consistent with the existing suite:

- **Host-gate** (`test/dashboard-*`): allowlisted `*.ts.net` host accepted (absent/443
  port); arbitrary public host rejected; `127.0.0.1` strict-port behavior unchanged;
  **token still required** for an allowlisted host (allowlist ≠ auth bypass);
  non-`*.ts.net` value in the env var still matched literally but nothing wildcard.
- **Confirm-write gating**: `gh issue create` (stubbed) fires **only** on the confirm
  POST, **never** on a chat-message POST; label allowlist rejects unknown labels
  before any spawn.
- **Concierge proposal parsing**: a reply with a `concierge-proposal` block yields a
  `{title, body, labels}` proposal; malformed/absent block → no proposal (plain
  reply); reuse the console ask-stub from existing dashboard tests.
- **Mobile PWA**: zero-dep DOM tests in the existing frontend-qa L0 tier (render chat,
  render proposal card, Confirm posts the reviewed body).
- **Helper**: `mesh-mobile-serve.mjs` with `tailscale` stubbed — prints URL + token
  link; absent `tailscale` → remediation message, non-zero exit.

## Rollout

1. Land the code via PR → merge to `main`; deploy-sync auto-ships it to the running
   dashboard.
2. Owner: install Tailscale on Mac + phone, `tailscale up` (one-time interactive
   login), run `node scripts/mesh-mobile-serve.mjs`, open the printed `/m?t=` link on
   the phone, add to home screen.
3. Verify end-to-end: chat → proposal → Confirm → issue appears → daemon picks it up;
   Status view reflects live state.

## File-level summary

| Component | File(s) | New/changed |
| --- | --- | --- |
| Host-gate allowlist | `src/dashboard/server.js` | changed |
| Concierge endpoints | `src/dashboard/concierge.js` (+ route wiring in server.js) | new + changed |
| Mobile PWA | `src/dashboard/public/mobile/` (html/css/js + manifest) | new |
| Concierge agent | `dev-mesh/agents/concierge/` (AGENT.md, registry, mcp via doctor) | new |
| Tailscale helper | `scripts/mesh-mobile-serve.mjs` | new |
| Config | `src/config.js` (`AGENT_MESH_DASHBOARD_ALLOWED_HOSTS`) | changed |
| Tests | `test/dashboard-concierge.test.js`, host-gate cases, PWA DOM tests, helper test | new |
| Docs | this spec; update `dev-mesh/DEPLOY-A2A-SOCIETY.md` mobile section | new + changed |
