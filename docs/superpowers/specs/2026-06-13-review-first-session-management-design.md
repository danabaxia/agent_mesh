# Review-First Session Management — copy-command, auto-follow, stitched timeline — Design

**Date:** 2026-06-13
**Status:** draft for review
**Decisions:** dashboard keeps chat, terminal becomes the primary input · no terminal spawning ever (EDR) — copy-command replaces launch · auto-follow the live user session, made deterministic by provenance-complete spawn tagging · stitched cross-session agent timeline in the canvas · `/open-terminal` deprecated in place, not removed

## 1. Goal

The dashboard's ⌘ Terminal button spawns PowerShell to run `claude --resume` —
and corporate EDR (CrowdStrike) intermittently kills it despite two prior
hardening rounds ("PowerShell-only launch", "drop -ExecutionPolicy Bypass").
Spawning is structurally the wrong side of that fight: anything the dashboard
executes can be blocked.

This redesign inverts the flow. The dashboard becomes a **review-first**
surface: it knows exactly where every agent's sessions live on disk, hands the
user a **copy-paste command** instead of spawning anything, **auto-follows**
the session the user opens in their own terminal, and renders the agent's
history as **one stitched timeline across sessions** — so typing in the real
CLI mirrors live on the dashboard, and fragmentation across session ids
(deliberate restarts, generation rotation) reads as one continuous stream with
seams instead of a canvas reset.

Dashboard chat (`runTurn`) stays as a secondary input; headroom rotation and
the digest pipeline ([2026-06-12 spec](2026-06-12-session-generations-design.md))
continue to govern dashboard-driven sessions unchanged.

## 2. Scope & non-goals

**In scope (v1):**
- Provenance-complete spawn tagging at the `delegateTask` chokepoint (the
  auto-follow foundation, §3).
- Follow policy: live-user-session ⟶ canonical ⟶ newest, sticky, pinnable (§4).
- Copy-command endpoint + UI replacing the launch button (§5).
- Storage transparency: per-agent projects-dir path + per-session transcript
  paths surfaced with copy affordances (§6).
- Stitched agent timeline in the session canvas (§7).

**Non-goals (explicit):**
- **No removal of `/open-terminal`** — the route stays for API compatibility,
  marked deprecated; the UI stops using it. The shell-launcher module is not
  deleted in v1.
- **No SessionStart-hook session reporting** — discovery stays scan-based
  (4 s poll); the first-checkpoint blind window (§8) is accepted, not hidden.
- **No cross-AGENT timeline** — stitching is within one agent's sessions.
- **No change to rotation/digest/memory** — the generations machinery is a
  consumer of this design (its `rotate` events label timeline seams), not a
  subject of it.
- **No mirroring-fidelity engineering beyond the transcript** — external CLI
  sessions mirror at the cadence Claude Code writes its transcript (the mirror
  already tails at 700 ms + fs-watch). Checkpoint-batched updates on some CLI
  versions are a documented bound, not a bug to fix here.

## 3. Provenance-complete spawn tagging (the follow foundation)

Auto-follow must distinguish *the user's* session from transcripts the
framework itself mints in the same `~/.claude/projects/<encoded>/` dir. Today's
provenance: dashboard turns record `create source:'dashboard'`
([session-runner.js:190](../../../src/dashboard/session-runner.js#L190)), peer
threads record `create source:'peer:<caller>'`
([stdio-server.js deriveCallerSession](../../../src/a2a/stdio-server.js)), and
generation rotation records `kind:'rotate' source:'headroom'`. But **sessionless
framework spawns are invisible**: scheduler jobs, digest workers, and plain
`delegate_task` calls run `claude -p` with no `--session-id`, so their
transcripts surface as `originSource:'cli'` — indistinguishable from the user.

**Fix at one chokepoint:** in `delegateTask`'s claude-argv assembly
([src/delegate.js](../../../src/delegate.js)), when the caller passed no
`session`, generate one: `session = { id: randomUUID(), resume: false }`, pass
`--session-id <id>` (both `ask` and `do` — both write transcripts), and
**best-effort** record `{ kind:'create', source:`worker:${route || mode}`,
sessionId, agentRoot }` via the shared provenance store, keyed by the mesh root
from `AGENT_MESH_MESH_CEILING` (the env the scheduler/runner already thread).
No mesh env (standalone agent) → skip tagging silently — standalone agents
have no dashboard to confuse. Tagging failures never fail the delegation
(same posture as the peer label).

After this, origin classes are exhaustive: `dashboard`, `peer:*`, `worker:*`,
`headroom` (rotated-in generations), and `cli` — where **`cli` now reliably
means a human's terminal session.**

Invariant check: the generated id is framework-side only — the model-facing
surface stays `{mode, task}`; `--session-id` on a fresh id changes no behavior
of the spawned turn (same fresh context, now with a known id).

## 4. Follow policy

A pure function (new `src/dashboard/public/follow-policy.js`, unit-tested
standalone) decides which session the canvas tracks each 4 s poll:

```
followTarget(rows, { currentId, pinnedId, lastSeen }) →
  1. pinnedId                                  (user pinned a session — never auto-switch)
  2. the LIVE USER session: a row whose transcript grew since the last poll
     (endedAt/mtime advanced vs lastSeen) AND originSource ∈ {cli, dashboard}
     — never peer:* / worker:*. If several, the most recently grown.
  3. else currentId while it stays active      (sticky — no flapping when the
                                                user pauses to think)
  4. else canonicalId                          (today's behavior)
  5. else newest row
```

`session-view` swaps its `loadCanonical` for this policy; everything downstream
(stream open/close, transcript windowing) is unchanged. A visible badge shows
the mode — `● following live CLI session` / `pinned` — with a one-click
pin/unpin. Rows already carry `active`, `endedAt`, `originSource`; the client
keeps the previous poll's `endedAt` per id to detect growth, so the server adds
nothing for this section.

## 5. Copy-command (replaces the launcher)

New route `GET /api/agent/:name/session/resume-command?id=<uuid|latest|new>`
returns `{ command, cwd, shell }`, built server-side beside the existing
`buildPlan` command construction — same validation gates (manifest-resolved
agent root; `id` through `resolveTranscript`/UUID + the canonical-reservation
exception, exactly like `/open-terminal` today), **no process ever started**:

- win32 → `cd '<root>'; claude --resume <id>` (PowerShell quoting: embedded
  `'` doubled)
- POSIX → `cd '<root>' && claude --resume <id>`
- `id=latest` resolves to the newest **user-origin** session (falls back to
  canonical, then newest); `id=new` emits plain `claude` (auto-follow catches
  the fresh session); a reserved-canonical id with no transcript yet emits
  `--session-id <id>` (first-launch seeding, same rule the launcher used).

UI: the ⌘ Terminal button becomes **⧉ Copy resume command** (per-session rows
get the same affordance); a small toast confirms the copy. `/open-terminal`
keeps working but nothing in the UI calls it; its handler gains a one-line
deprecation comment pointing here.

`claude --continue` is deliberately NOT emitted: it is a recency heuristic
(CLAUDE.md lesson) — the dashboard always knows the exact id, so it always says
`--resume <id>`.

## 6. Storage transparency

`/session/list` gains `projectsDir` — the exact transcript directory for the
agent, `join(PROJECTS_DIR, encodeProjectDir(realpath(agentRoot)))` (canonical,
matching the post-8.3-fix identity). Rows already carry `transcriptPath`. The
session panel renders a storage line ("sessions live in: <path> ⧉") and each
row exposes its transcript path on hover/expand with a copy affordance. Pure
display — no new file IO (the values fall out of existing computation).

## 7. Stitched agent timeline

The canvas model generalizes from one session to an ordered list of
**segments**:

```
segments = [ { sessionId, startedAt, originSource, label, records[] } … ]
ordered by startedAt; the followed (live) session is the LAST segment.
```

- **Seam dividers** between segments, labeled from provenance: a `rotate`
  event → "generation rotated (digest applied)"; otherwise by origin —
  "new CLI session", "dashboard session". Dividers carry the session id
  (clickable → pin that segment's session).
- **Initial render**: the live segment (existing windowed `/transcript` load)
  plus the immediately previous segment's divider; **older segments lazy-load
  on scroll-up**, one session at a time, via the existing per-session
  `/transcript?beforeSeq=` pagination — no new server API. Seq cursors remain
  per-session; the stitched model addresses records as `(sessionId, seq)`.
- **Follow switch**: when the policy moves to a new live session, the current
  segment is sealed in place, a divider appended, and the new segment streams
  below — **nothing is cleared**. Memory bound: segments beyond the last
  `MAX_STITCHED_SEGMENTS` (8) are dropped from the DOM/model oldest-first
  (scroll-up re-fetches them).
- Peer/worker sessions never appear as segments (they are filtered by origin),
  but remain fully reviewable by explicit click from the inventory, which
  renders them in the classic single-session view.

The existing single-session SSE stream is untouched — the live segment owns the
one open stream; sealed segments are static records.

## 8. Error handling & honest limits

- **First-checkpoint blind window:** a freshly started CLI session has no
  transcript for the first seconds; the canvas keeps the prior segment and
  shows the new one only when the file appears (next poll). Accepted; the
  copy-command UX sets the expectation ("session appears here once Claude
  writes its first checkpoint").
- **Checkpoint-batched mirroring:** on CLI versions that checkpoint rather
  than append, mid-turn mirroring is bursty. Documented bound (§2).
- **Two simultaneous user sessions** on one agent: the policy follows the most
  recently grown; the badge + pin is the escape hatch. No attempt to merge
  concurrent streams.
- **Follow never errors:** every fallback ends at "newest row"; a vanished
  transcript (deleted session) re-runs the policy on the next poll.
- Copy-command with an unknown id → the same clean 404 the launcher returned.

## 9. Security / invariants

- The dashboard **loses** its only process-spawning user affordance; nothing
  new is executed anywhere. Copy-command emits text built exclusively from
  framework-validated values (manifest-resolved realpath root, UUID-validated
  session id) and quotes them defensively anyway.
- Spawn tagging adds no model-facing surface: ids are framework-generated,
  provenance writes are framework-side, `{mode, task}` anti-spoof unchanged.
- Transcript access for every new display path stays behind `resolveTranscript`
  containment. Path strings shown in the UI are operator-owned localhost data
  (existing dashboard trust model).
- `do`-mode spawns gaining `--session-id` changes no write-tool surface, no
  path-guard behavior, no queueing.

## 10. Testing (hermetic)

1. **Tagging:** delegateTask with no session → argv carries `--session-id`,
   provenance has `create source:'worker:<route>'` (ask AND do); explicit
   session passed → untouched (peer path regression); no mesh env → no event,
   no failure; tagging-store write failure → delegation still succeeds.
2. **Follow policy (pure):** live cli session beats canonical; worker:*/peer:*
   never followed even when newest+active; sticky while active; pin wins over
   everything; quiet current + new live → switch; full fallback chain.
3. **Copy-command:** win32 vs POSIX quoting (roots with spaces and quotes);
   `latest` resolves user-origin first; `new` → bare `claude`;
   reserved-canonical-no-transcript → `--session-id`; bad id → 404; response
   never contains anything but the validated root/id.
4. **Stitched model (pure):** segment ordering, divider labels from
   provenance (`rotate` vs cli vs dashboard), (sessionId, seq) addressing,
   lazy-load cursor math, MAX_STITCHED_SEGMENTS eviction, seal-on-switch keeps
   records.
5. **Routes:** `/session/list` carries `projectsDir`; `/open-terminal` still
   answers (deprecated, unchanged behavior).
6. Full suite green under the CI gate (ubuntu+windows × node 20/22).

## 11. Decisions (resolved)

- **D1 — dashboard keeps chat**; terminal is primary, not exclusive. Rotation
  /digest continue to apply to dashboard-driven sessions.
- **D2 — auto-follow via provenance-complete tagging** (deterministic), not
  mtime heuristics; sticky + pinnable.
- **D3 — copy-command replaces spawn**; `--resume <id>` always, never
  `--continue`; `/open-terminal` deprecated in place.
- **D4 — stitched timeline ships in v1** (it is the answer to "where did my
  history go" once sessions fragment).
- **D5 — tagging lives in delegateTask's argv assembly** — one chokepoint
  covers scheduler, digest, orchestrator inner delegations, and direct MCP
  `delegate_task`, both modes.
- **D6 — fidelity bounds accepted**: scan-based discovery (≤4 s), transcript
  write cadence, first-checkpoint blind window.

## 12. Review log

- **Implementation (2026-06-13):** landed on branch claude/dreamy-goodall-vcvash per docs/superpowers/plans/2026-06-13-review-first-session-management.md — 8 tasks, TDD, per-task spec+quality reviews (Task 7's four implementation deviations adjudicated and upheld); suite green at the environment's documented baseline (change-detect ×4, sandbox git-signing artifact). Independent codex pass still pending CLI availability.
