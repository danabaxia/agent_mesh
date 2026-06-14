# Managed-Wiring Auto-Sync — framework auto-applies doctor for Managed artifacts — Design

**Date:** 2026-06-13
**Status:** draft for review
**Decisions:** auto-apply on a debounced watcher trigger (not just notify) · on by default, `AGENT_MESH_NO_AUTOSYNC` opt-out · Managed-only/surgical (registry.json + peer-bridge .mcp.json; never Seeded/Authored) · framework process writes (Boundary-5 admin workflow), never an agent · concurrency-safe via atomic config writes, no turn-gating

## 1. Goal

After a framework code update — or after a user edits `mesh.json` / an agent's
`agent.json` — the **derived wiring** drifts: an agent's `registry.json`
(generated peer list) and its peer-bridge `.mcp.json` entry no longer match the
manifest. Today the only fix is to **manually** run `agent-mesh doctor --apply`.
Nothing re-syncs automatically; the dashboard watcher
([src/dashboard/watcher.js](../../../src/dashboard/watcher.js)) is read-only —
it refreshes the UI but mutates nothing.

This makes the **framework process** (the dashboard, which already runs outside
the path-guard) keep Managed wiring current automatically: on startup and on a
debounced watcher-detected config change, it runs `doctor` in a new
**Managed-only** mode that regenerates *only* the marker'd `registry.json` and
the peer-bridge `.mcp.json` — leaving Seeded (`agent.json`, prompts) and
Authored files exactly as the existing ownership model already treats them
(propose / flag, never auto-write).

**Division of labor (companion to the mesh-manager design):** the
`mesh-manager` agent *detects and proposes* (read-only, via `check_conformance`
— [2026-06-11 spec](2026-06-11-mesh-manager-agent-design.md)); this design is
the *apply* half, done by the framework, not by any agent. An agent that edits
other agents' folders is explicitly the wrong primitive (single writable root);
the dashboard process is the sanctioned place for the apply.

## 2. Scope & non-goals

**In scope (v1):**
- `doctor()` gains a `managedOnly` option (regenerate registry + bridge only).
- A debounced, serialized auto-sync coordinator
  (`src/dashboard/auto-sync.js`).
- Wiring in `src/dashboard/server.js`: run once at startup; trigger on the
  existing watcher change callback; emit a coarse SSE `sync` event.
- Atomic writes for the two Managed writers (concurrency hardening).
- Minimal UI: a toast on the `sync` event.
- Opt-out env + debounce override.

**Non-goals (explicit):**
- **No agent-driven apply** — the mesh-manager stays propose-only; nothing here
  grants an agent cross-folder write power.
- **No Seeded/Authored auto-write** — `.proposed` patches and Authored flags
  remain exclusively for an explicit `agent-mesh doctor --apply`.
- **No scaffolding of brand-new bare folders** — `seedMissingAnatomy` (creating
  a missing `agent.json`/prompts) stays manual via `agent-mesh add`. Auto-sync
  keeps *existing* agents' wiring current; it does not stand up new agents.
- **No new CLI surface** — `agent-mesh doctor [--apply]` is unchanged; the
  `managedOnly` mode is an internal option used by the dashboard, not a flag.
  (A `--managed-only` CLI flag is a trivial future add if wanted.)
- **No turn/lease coordination** — made unnecessary by atomic config writes
  (§5); auto-sync does not consult the session-runner lease.

## 3. `doctor` Managed-only mode

`doctor(meshRoot, { agentName?, apply?, managedOnly? })`
([src/builder/doctor.js](../../../src/builder/doctor.js)). The per-agent loop
runs four steps today: (1) `fixRegistry` [Managed], (2) `seedMissingAnatomy`
[Seeded create], (3) `proposeSeededFixes` [Seeded propose], (4) `syncBridgeMcp`
[Managed]. With `managedOnly: true`, **only steps 1 and 4 run** — steps 2 and 3
are skipped entirely. The return shape `{ fixed, seeded, proposed, flagged }`
is unchanged; in Managed-only mode `seeded`/`proposed` are simply always empty.

`managedOnly` is independent of `apply`: `{apply:false, managedOnly:true}` is a
Managed-only dry-run (what *would* sync); `{apply:true, managedOnly:true}` is the
auto-sync's actual call. Default `managedOnly:false` preserves every existing
caller (`agent-mesh doctor`, the mesh-health `check_conformance` dry-run) byte
for byte.

Both Managed writers are already **idempotent**: `syncBridgeMcp` compares
desired vs on-disk and returns early when equal
([doctor.js](../../../src/builder/doctor.js#L120)); `fixRegistry` only rewrites a
drifted/absent marker'd registry. So a Managed-only apply over an in-sync mesh
writes nothing and reports an empty `fixed`.

## 4. Auto-sync coordinator

New `src/dashboard/auto-sync.js` — pure-ish, hermetically testable, no direct
`doctor`/timer imports (all injected):

```
createAutoSync({ runSync, schedule = setTimeout, clearSchedule = clearTimeout,
                 debounceMs, onResult, log }) → { trigger, runNow, stop }
```

- **`trigger()`** — (re)arm the debounce timer. Bursts of watcher changes
  collapse to one run `debounceMs` after the last change.
- **Serialized with coalesced rerun** — a single in-flight guard; if `trigger()`
  fires while a run is in progress, a `pendingRerun` flag is set and exactly one
  more run is scheduled after the current one completes (so a change landing
  mid-sync is never lost, and runs never overlap).
- **`runNow()`** — immediate run (startup), bypassing debounce; still respects
  the in-flight guard.
- **emit-only-on-change** — `runSync` returns `doctor`'s result; `onResult` is
  invoked **only when `fixed[]` is non-empty** (real wiring changed). An
  idempotent no-op run emits nothing — no spurious toast, no SSE noise.
- **`stop()`** — clear the timer; mark stopped so a late debounce fire no-ops.
- Never throws to the caller: `runSync` rejection is caught, `log`'d, and passed
  to `onResult` as `{ ok:false, error }` (the server decides whether to surface
  a `sync failed` event).

## 5. Concurrency & safety

- **Atomic config writes (the key hardening).** The two Managed writers route
  their `writeFile` through the existing `atomicWriteFile`
  ([src/atomic-write.js](../../../src/atomic-write.js), temp + rename). A
  `claude` session launching at the instant of a sync therefore reads either the
  old or the new `registry.json`/`.mcp.json` — never a torn half-write. Because
  `claude` loads its config only at launch, a rewrite during an *already-running*
  session is inert. This is why auto-sync needs **no** session-runner lease
  coordination.
- **Serialized + debounced + coalesced** (§4) — no overlapping syncs; bursts
  collapse; a mid-run change still gets one follow-up pass.
- **Managed-only by construction** — §3 restricts writes to marker'd
  `registry.json` + peer-bridge `.mcp.json`. The ownership model already forbids
  touching Authored content and only *proposes* Seeded; Managed-only further
  drops even the Seeded proposals from the auto path.
- **Idempotent** — no drift → no write → no event.
- **Opt-out** — `AGENT_MESH_NO_AUTOSYNC=1` → the coordinator is never
  constructed; the watcher still feeds the UI exactly as today.
- **Invariant check** — the writer is the **dashboard/framework process**
  (outside the path-guard), which is precisely the "separate admin workflow"
  Boundary 5 reserves for self-modifying config. No agent gains cross-folder
  write capability; the single-writable-root model and the mesh-manager's
  propose-only posture are unchanged. `managedOnly` cannot write outside an
  agent's own `registry.json`/`.mcp.json` (the same paths `doctor` already
  manages).

## 6. Data flow

```
startup (dashboard):
  if !AGENT_MESH_NO_AUTOSYNC:
    autoSync.runNow()  → doctor(mesh,{apply:true,managedOnly:true})
                       → log synced[]; if fixed[].length: SSE 'sync' event

watcher detects a change (existing path):
  onChange(scopes)   → (existing) UI change event over /api/events
                     → (new) autoSync.trigger()
                          → debounce DEBOUNCE_MS
                          → doctor(mesh,{apply:true,managedOnly:true})
                          → if fixed[].length: SSE 'sync' event {synced, at}
```

The watcher payload is coarse and secret-safe (scope names only, never paths —
[watcher.js](../../../src/dashboard/watcher.js)); we do not filter by which
file changed (the event can't carry it). Over-triggering is harmless: an
idempotent Managed-only apply over an in-sync mesh writes nothing and emits
nothing. `doctor`'s own `fixed[]` strings (e.g. ``[coder] .mcp.json —
peer-bridge entry synced``) are agent-name + action, not secrets, so they are
safe to put on the SSE `sync` event.

## 7. Observability (SSE)

A new coarse event on the existing `/api/events` stream:
`{ kind:'sync', synced: string[], at: <ms> }` where `synced` is `doctor`'s
`fixed[]`. On failure: `{ kind:'sync', ok:false, error:<code/message>, at }`.
The frontend shows a small, dismissable toast ("Wiring synced: coder, fracas" /
"Auto-sync failed — run `agent-mesh doctor` to inspect"). UI work is
intentionally minimal — one event handler + a toast, reusing the page's
existing flash/toast affordance.

## 8. Error handling

- `doctor` throws (missing/unreadable `mesh.json`, etc.) → caught in `runSync`'s
  wrapper, `log`'d, surfaced as `{ ok:false, error }`; the dashboard never
  crashes. Failure is data — consistent with the mesh contract.
- A partial sync (one agent's registry fails to write) → `doctor` records it in
  `flagged[]` and continues other agents (existing behavior); the auto path
  still emits the partial `synced[]`.
- Atomic-write failure on one file leaves the prior file intact (temp never
  renamed); the next trigger retries.

## 9. Components & changes

| Component | Change |
|---|---|
| `src/builder/doctor.js` | + `managedOnly` option (gate to steps 1+4); route the two Managed writers through `atomicWriteFile` |
| `src/dashboard/auto-sync.js` (new) | debounced, serialized coordinator (§4) |
| `src/dashboard/server.js` | construct auto-sync (unless opted out); `runNow()` at startup; `trigger()` in the watcher `onChange`; SSE `sync` event; `stop()` on close |
| `src/dashboard/public/*` | one SSE `sync` handler → toast (minimal) |
| `src/config.js` | `DEFAULT_AUTOSYNC_DEBOUNCE_MS` (2000); read `AGENT_MESH_NO_AUTOSYNC`, `AGENT_MESH_AUTOSYNC_DEBOUNCE_MS` |
| `src/atomic-write.js` | reused (no change) |
| docs | CLAUDE.md config line; PROJECT.md changelog; spec §11 note |

## 10. Testing (hermetic)

1. **`doctor managedOnly`:** with a mesh whose registry/bridge drift + a Seeded
   gap, `{apply:true, managedOnly:true}` rewrites registry + `.mcp.json` only,
   `seeded`/`proposed` empty (the Seeded gap is left untouched); a second run is
   a no-op (`fixed` empty); writes are atomic (temp file gone, content correct).
   `{managedOnly:false}` unchanged from today (regression).
2. **Coordinator (pure, injected seams):** debounce coalesces N triggers → 1
   run; a `trigger()` during an in-flight run schedules exactly one rerun;
   `runNow` bypasses debounce; `onResult` fires only when `fixed[]` non-empty;
   `runSync` rejection → `{ok:false}` to `onResult`, no throw; `stop()` cancels a
   pending fire.
3. **Server wiring:** startup `runNow` fires once; a watcher `onChange` calls
   `trigger`; a changed result emits an SSE `sync` event of the right shape; an
   in-sync mesh emits none; `AGENT_MESH_NO_AUTOSYNC=1` constructs no coordinator
   (watcher UI events still flow).
4. **Atomic concurrency:** a registry rewrite is observable as old-or-new only
   (no zero-length/partial read) — assert via temp-then-rename, not a real race.
5. Full suite green under CI (ubuntu+windows × node 20/22); `doctor`/`add`/
   `join`/`conformance`/`dashboard-server`/`dashboard-watcher` suites stay green.

## 11. Decisions (resolved)

- **D1 — trigger:** auto-apply on a debounced watcher change (not notify-only),
  plus a startup run. Debounce `DEFAULT_AUTOSYNC_DEBOUNCE_MS` (2000).
- **D2 — default:** on by default; `AGENT_MESH_NO_AUTOSYNC=1` opts out.
- **D3 — scope:** Managed-only (registry + bridge); Seeded/Authored never
  auto-written.
- **D4 — concurrency:** atomic config writes, no lease coordination.
- **D5 — apply lives in the framework**, never an agent (mesh-manager stays
  propose-only).
- **D6 — internal option, no CLI flag** in v1.

## 12. Review log

- **Implementation (2026-06-13):** landed on branch claude/dreamy-goodall-vcvash per docs/superpowers/plans/2026-06-13-managed-wiring-autosync.md — 6 tasks, TDD, per-task spec+quality reviews; suite green at the environment's documented baseline (change-detect ×4, sandbox git-signing artifact). Independent codex pass still pending CLI availability.
