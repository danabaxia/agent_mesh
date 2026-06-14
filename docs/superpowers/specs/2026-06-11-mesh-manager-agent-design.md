# Mesh-Manager Agent — Design

**Date:** 2026-06-11
**Status:** approved
**Decisions:** observer + proposer authority · health = conformance + liveness + log triage · swept by the existing mesh scheduler · health data via a new read-only `mesh-health` MCP server (Approach B)

## 1. Goal

Add a `mesh-manager` agent to the live mesh (`my-mesh/`) that is a **real mesh agent** — its own folder, A2A card, dashboard presence — whose role is mesh operations: scheduled health sweeps over the whole mesh, human-readable health reports, and **fix proposals**. It observes and proposes; it never mutates the mesh. Applying fixes (e.g. `agent-mesh doctor --apply`) stays with the human or the dashboard.

Why this shape: the mesh's security invariants (single writable root, no Bash in `do`, anti-spoof) make "an agent that edits other agents" the wrong primitive. An agent that *reads everything through a vetted tool surface and writes only into its own deliverables* needs no new privileges and no invariant changes.

## 2. The agent (no framework changes)

`my-mesh/mesh-manager/`, created with the existing builder (`agent-mesh add`):

- **`agent.json`** — name `mesh-manager`; description: "Mesh operations manager — runs scheduled health sweeps (conformance, liveness, log triage) and writes health reports with fix proposals." Modes `["ask","do"]`, same card shape as the other five agents. The dashboard renders its card, graph node, and timeline with zero dashboard changes.
- **`mesh.json` entry** — `served: true`; peers = all five existing agents (knowledge, data-analyst, coder, fracas, presentation), and `mesh-manager` is added to each of their peer lists (bidirectional, matching the current full-mesh wiring).
- **`AGENT.md`** — the management role, framed as data per the existing invariant.
- **`CLAUDE.md`** — operating instructions: how to interpret check results, report format, proposal conventions ("propose the exact CLI command; never claim to have fixed anything").
- **Reports** land in `mesh-manager/deliverables/YYYY-MM-DD/health-sweep/` via the scheduler's `saveArtifact` — browsable in the dashboard like any deliverable.

## 3. `mesh-health` MCP server (the one new component)

A framework-shipped, read-only stdio MCP server (`src/mesh-health/server.js` + a bin entry), registered in `my-mesh/mesh/mcp.json` with `"x-agentmesh": { "readOnly": true }` so it is ask-mode grantable mesh-wide (same posture as `internal-files`). Mesh root comes from env (`AGENT_MESH_MESH_CEILING` / parent of `AGENT_MESH_MESH_ROOT`, the convention the scheduler already threads) — never from tool arguments.

### Verbs

| Verb | Wraps | Returns |
|---|---|---|
| `check_conformance()` | existing `loadSnapshot` + `checkConformance` + `doctor(meshRoot, {apply:false})` | structured dry-run report: auto-fixable (managed), proposable (seeded), flagged (authored) |
| `ping_agent({name})` | manifest lookup + `serve-a2a` spawn via `spawnFile`/`resolveSpawnTarget` + `initialize`/`ping` (the `scripts/live-a2a-check.mjs` probe) | `{ alive, latency_ms, error? }` |
| `triage_logs({agent?, since_hours?})` | file reads over `<agent>/.agent-mesh/logs/*` and `schedule-state.json` | failure/timeout/refused counts + most recent entries with log paths |

### Security posture

- All verbs are read-only on the mesh. `ping_agent` spawns a process but writes nothing and applies its own timeout (10s default, `AGENT_MESH_HEALTH_PING_TIMEOUT_MS` override) + process-**tree** kill (`detached: true`, kill `-pid`), mirroring `delegate.js`.
- `name` is data validated against the operator-owned manifest (`readManifest` over `mesh.json`, which lives outside every agent's writable root); the server never accepts filesystem paths from the model (anti-spoof, same philosophy as the peer bridge).
- No mutating verbs exist in v1. A future "apply fixes" capability would be a separate, separately-designed server — explicitly out of scope here.
- New spawn sites route through `spawnFile`/`resolveSpawnTarget` (Windows `.cmd` shim lesson).
- Accepted disclosure: the server is mesh-global and readOnly-granted, so every ask-mode worker can see cross-agent log paths, conformance details, and `triage_logs`' content-bearing `schedule[].last_summary` — accepted within the single-trust-domain model (PROJECT.md §1.5).

## 4. Scheduled sweep + report contract

Job in `mesh-manager/.agent/schedule.json` (existing scheduler, no changes):

```json
{ "jobs": [{
  "id": "health-sweep",
  "name": "Mesh health sweep",
  "cadence": "daily",
  "enabled": true,
  "saveArtifact": true,
  "prompt": "Run a full mesh health sweep: call check_conformance, ping every served agent, and triage logs for the last 24h. Write a health report: overall status (green/yellow/red), per-agent table, findings with evidence, and a Fix Proposals section for anything actionable."
}]}
```

The scheduler runs it as an ask-mode delegation; `saveArtifact: true` persists the report — the agent itself needs no write path for reporting.

**Report format** (pinned by a skill so reports stay diffable run-to-run; skill lives agent-local at `mesh-manager/skills/health-report-format/` in v1 — promote to mesh-level only if other agents later need to cite health status):

1. Status banner: GREEN / YELLOW / RED + one-line reason
2. Per-agent table: conformance · liveness (latency) · recent failures
3. Findings, each with evidence (log path / file path)
4. Fix Proposals: exact command or change, e.g. "run `agent-mesh doctor --apply` to regenerate coder's `registry.json`" — proposals only, never claimed as done

The trigger is the dashboard scheduler, accepted trade-off: dashboard down → no sweep. (A Windows Task Scheduler backstop was considered and deferred.)

## 5. Error handling

- A failing verb returns structured `{error}` data; the server never crashes the sweep. The report marks the affected agent **unknown/red**. Failure is data — consistent with the mesh contract.
- A hung peer cannot wedge a sweep: `ping_agent` timeout (10s default) + tree-kill.
- A failing sweep job surfaces as the scheduler's `lastStatus: 'fail'` on the dashboard; the next sweep's `triage_logs` sees it (self-monitoring for free).
- The manager does not ping itself; conformance still covers its own folder.

## 6. Testing

- **`test/mesh-health.test.js`** (hermetic): `check_conformance` against fixture meshes (reuse conformance fixtures); `triage_logs` against synthesized logs/state including the empty/corrupt-file cases; `ping_agent` against a real `serve-a2a` over a temp mesh, plus a hang fixture proving timeout + tree-kill.
- **MCP wire test**: spawn the server over stdio; `initialize` / `tools/list` / `tools/call` round-trips; exactly three tools exposed.
- **Windows live check**: extend `scripts/live-a2a-check.mjs` (or sibling script) with one real sweep against `my-mesh`.
- Agent folder content is validated by `agent-mesh conformance`, not unit tests.

## 7. Out of scope (v1)

- Mutating admin verbs (apply fixes, join/leave) — separate design if ever wanted.
- MCP server reachability checks (the "python script moved" class) — natural v2 verb (`check_mcp_servers`), deliberately deferred.
- Dashboard health badges driven by sweep output — the report deliverable is the v1 surface.
