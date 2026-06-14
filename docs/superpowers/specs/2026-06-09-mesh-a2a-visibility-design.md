# Mesh-Level A2A Visibility — Design

> Status: design approved 2026-06-09. Next: implementation plan (writing-plans).
> Builds on the onward-delegation surface ([2026-06-06-onward-delegation-design.md](2026-06-06-onward-delegation-design.md))
> and the multi-turn peer sessions work ([2026-06-09-multi-turn-peer-sessions-design.md](2026-06-09-multi-turn-peer-sessions-design.md)).

## 1. Problem

A2A onward delegation (`delegate_to_peer`, B→C) is invisible to the dashboard's
activity board in two cases:

1. **The child never starts.** A refusal or spawn failure inside the peer bridge
   (`mode_disabled`, `caller_identity_unresolved`, `bad_input`, `spawn_failed`)
   returns before any `delegate-*` run log is written on the peer side, so there is
   no record anywhere that the call happened.
2. **No `AGENT_MESH_RUN_ID`.** The board's edges are inferred purely from
   `parent_run_id → child id` ([activity.js:44-53](../../../src/dashboard/activity.js#L44)),
   and the parent record must be present in the same dataset. An interactive
   session (or any caller without `AGENT_MESH_RUN_ID` in env) emits no
   `parent_run_id`, so **no edge is drawn** even though the delegation happened.

Separately, peer **session provenance** is mis-keyed: `deriveCallerSession` writes
the `from:<caller>` label and `create` event under the **peer's own root**
([stdio-server.js:365-366](../../../src/a2a/stdio-server.js#L365)), but the
dashboard reads labels/events keyed by the **mesh root** — so knowledge sessions
never show as `from:data-analyst`.

The fix: a dedicated mesh-level A2A audit log written by the bridge (authoritative
cross-agent traffic record, independent of whether the child starts), surfaced as
explicit activity edges, plus the provenance key correction.

## 2. Goals / non-goals

**Goals**
- A durable record of every `delegate_to_peer` attempt — including refusals and
  spawn failures — written under the **caller** agent.
- The dashboard activity view shows A2A traffic as explicit `from → to` edges and
  text-free events, even with no `AGENT_MESH_RUN_ID`.
- Peer sessions are correctly named `from:<caller>` in the dashboard.

**Non-goals**
- No change to the A2A wire protocol or to what each agent's **claude transcript**
  contains. The transcript stays conversation-local (what that agent actually
  saw); the a2a log is the authoritative *cross-agent* record. We do **not** fold
  A2A audit data into transcripts.
- No new text/paths on the board view-model (see §6 redaction boundary).

## 3. Data model — the `a2a-*.jsonl` record

A new grouped-by-date log type, written **under the caller agent**:

```
<caller-root>/.agent-mesh/logs/a2a-YYYY-MM-DD.jsonl
```

It reuses the existing run-log infrastructure verbatim — no new writer/reader:
- `createRunLog(callerRoot, env, 'a2a')` → `{ logPath, runId }` (the `prefix`
  param already exists, [log.js:24](../../../src/log.js#L24)).
- `appendRunLog(logPath, record)` for the NDJSON append (per-path serialized,
  cross-process O_APPEND atomic).
- `readRunLogRecords` / `dedupeRunRecords` on the read side (start+done collapse
  by `id`, last-wins).

A call that reaches `client.send` writes two records (`started` + `done`) sharing
one `id`; a pre-send refusal (§4.2) writes a single `done` record. Readers dedup by
`id`, last-wins:

```jsonc
{
  "kind": "a2a",
  "id": "a2a-2026-06-09T...-<rand>",   // shared start+done id
  "from": "data-analyst",              // resolved manifest caller name (bridge)
  "to": "knowledge",                   // the peer argument
  "mode": "ask",
  "message_id": "<A2A messageId>",
  "parent_run_id": "<env.AGENT_MESH_RUN_ID | null>",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601 | undefined",  // absent on the START record
  "state": "started" | "done",
  "status": "completed" | "rejected" | "timeout" | "error" | null,
  "error_code": "mode_disabled | caller_identity_unresolved | bad_input | spawn_failed | <peer error_code> | null",
  "child_log_path": "<peer log_path | null>",   // ON-DISK ONLY (never to board)
  "child_run_id": "<peer run_id | null>",        // ON-DISK ONLY
  "summary_preview": "<capped, path-redacted | null>"  // ON-DISK ONLY
}
```

- `from` is the manifest caller name the bridge already resolves (commit
  `c6c1189`); it is unique within the mesh, matching the agent identities the board
  uses. `to` is the registry/manifest peer name.
- `child_log_path` / `child_run_id` / `summary_preview` come from the mapped Task
  result and are **on-disk audit fields only** — §6 keeps them out of the board.
- `summary_preview` is capped (e.g. 200 chars) and path-redacted; it exists so the
  caller-side a2a log is greppable without opening the child's `delegate-*` log.

## 4. Write path — `peer-bridge.js` `delegateToPeer`

`createBridge({ root, env })` runs in the **caller** agent's folder, so `root` is
the caller root — the a2a log lands under the caller naturally.

The bridge's gates run in this order: `mode` check → `peer`/`task` arg validation
→ registry checks → caller-name resolution → `createClient` → `client.send`. So
`from` (caller name) and a registry-valid `to` are only known partway through. The
logging rule is therefore split by **whether we reach `client.send`**:

1. **Entry:** `createRunLog(root, env, 'a2a')` → `{ logPath, runId }`; capture
   `started_at`. Best-effort resolve `from` via the bridge's existing caller-name
   resolver so it is available even for an early refusal (`null` if unresolvable);
   `to` = the `peer` argument as given (`null` if absent). The log is created
   regardless of outcome — a refused attempt is exactly what we want recorded.
2. **Refusal at any gate before `client.send`** (`mode_disabled`, `bad_input`,
   `caller_identity_unresolved`, `spawn_failed`): append a **single**
   `state:"done"` record — `status:"rejected"`, `error_code` set, `finished_at`
   now, child fields `null`, `message_id` `null` (the A2A message was never sent).
   No `started` record, because no send was attempted. This is the case the
   existing logs miss entirely.
3. **Reaching `client.send`:** append `state:"started"` (`from`, `to`, `mode`,
   `message_id`, `parent_run_id`, `started_at`) **before** the send; then on the
   result append `state:"done"` (same `id`) mapped from the Task
   (`status`, `error_code`, `child_log_path`, `child_run_id`, `summary_preview`,
   `finished_at`). A thrown send maps to `status:"error"`.
4. Logging never changes the bridge's return value and never throws into the call
   path (append failures are swallowed/`stderr`-noted, matching the delegate-log
   best-effort posture).

`child_run_id`: the peer's A2A Task does not currently expose its run id. Add
`agentmesh/run_id` to the peer's emitted Task metadata in
`buildTaskFromDelegateResult` so the bridge can record `child_run_id`; until then
it is `null`. (Small, localized; the run id is already in the peer's own logs.)

## 5. Read + activity path

### 5.1 Loader — `server.js` `loadActivitySnapshot`
Widen the per-agent file filter to include the new prefix
([server.js:351-352](../../../src/dashboard/server.js#L351)):

```js
.filter((f) => (f.startsWith('delegate-') || f.startsWith('a2a-'))
            && (f.endsWith('.jsonl') || f.endsWith('.json')))
```

a2a records are read the same way (`readRunLogRecords` + `dedupeRunRecords` by
`id`). The existing "strip `log_path`/stdout/stderr before the view-model leaves"
contract ([server.js:334](../../../src/dashboard/server.js#L334)) is extended to
strip the a2a on-disk-only fields (§6).

### 5.2 Model — `activity.js` `buildActivity`
Records are split by `kind`:

- **delegate records** (no `kind` / `kind!=="a2a"`): unchanged — per-agent state
  map, `parent_run_id` edges, start/done events.
- **`kind:"a2a"` records**:
  - **explicit edge** `{ from, to, active: !finished_at, kind:"a2a" }`.
  - **a2a event** `{ kind:"a2a", from, to, mode, status, at }` — names + status
    only, no text/paths.
  - they do **not** enter the per-agent state map (no phantom agents from a record
    that merely describes traffic).

**Edge coexistence (decided):** dedupe edges by `from|to`. An explicit `a2a` edge
**supersedes** a `parent_run_id`-inferred edge for the same ordered pair (it is
richer and works without `AGENT_MESH_RUN_ID`), so the board never shows a duplicate
`data-analyst → knowledge` line when both a delegate parent-link and an a2a record
exist. `active` for a merged pair is the OR of the contributing edges' `active`.

## 6. Redaction boundary (security invariant preserved)

`activity.js` guarantees the board payload is "structurally incapable of carrying a
path, a secret, or model output." This design keeps that:

- `child_log_path`, `child_run_id`, `summary_preview` are written to
  `a2a-*.jsonl` on disk but are **never** emitted by `buildActivity`. The a2a edge
  is `{from,to,active,kind}`; the a2a event is `{kind,from,to,mode,status,at}`.
- The loader's existing redaction step is extended to drop the a2a on-disk-only
  fields, so even an accidental future passthrough is caught at the I/O boundary.
- A test asserts the board view-model for an a2a record contains no
  `child_log_path` / `summary_preview`.

The richer fields remain available where text is allowed: the on-disk log and the
Desk chat / child `delegate-*` log.

## 7. Provenance fix — `stdio-server.js` `deriveCallerSession`

Resolve the mesh root from the bridge-set env and key the dashboard naming by it:

```js
const meshRoot = env?.AGENT_MESH_MESH_CEILING
  || (env?.AGENT_MESH_MESH_ROOT ? dirname(env.AGENT_MESH_MESH_ROOT) : null);
const labelRoot = meshRoot || root;   // standalone peer (no mesh env) → best-effort fallback
try {
  await setLabel(labelRoot, id, `from:${caller}`);
  await recordEvent(labelRoot, { kind: 'create', source: `peer:${caller}`, sessionId: id, agentRoot: root });
} catch { /* cosmetic */ }
```

- The label/event **store key** becomes the mesh root (what the dashboard reads);
  `agentRoot` stays the peer's own root (identifies the owning agent).
- Remains best-effort/try-catch — a naming failure never fails the turn.
- Fallback to `root` only when there is no mesh env (peer run outside a mesh), so
  standalone behavior is unchanged.

## 8. Testing

1. **peer-bridge success:** a `delegate_to_peer` ask writes an a2a `state:"started"`
   then a `state:"done"` record (same `id`) under the caller root, with
   `from`/`to`/`status:"completed"`.
2. **peer-bridge refusal/failure:** a refused call (`mode_disabled` for a `do`, or
   `caller_identity_unresolved`) and a `spawn_failed` each write an a2a `done`
   record with `status:"rejected"` + the `error_code` — proving visibility when the
   child never starts.
3. **loader:** `loadActivitySnapshot` picks up both `delegate-*` and `a2a-*` files.
4. **activity edge:** a `kind:"a2a"` record yields an explicit
   `data-analyst → knowledge` edge; an interactive (no `parent_run_id`) case still
   produces the edge.
5. **no-leak:** the board view-model built from an a2a record contains no
   `child_log_path` / `child_run_id` / `summary_preview`.
6. **edge dedupe:** when both an a2a record and a `parent_run_id` link describe the
   same pair, exactly one `from→to` edge is emitted (the a2a one).
7. **provenance:** `setLabel`/`recordEvent` are keyed by the mesh root, not the
   agent root (assert the label is found under the mesh-root store); fallback to
   `root` when no mesh env is set.

## 9. Files touched

| File | Change |
|---|---|
| [src/a2a/peer-bridge.js](../../../src/a2a/peer-bridge.js) | write a2a start/done/error records around `delegateToPeer` |
| [src/a2a/stdio-server.js](../../../src/a2a/stdio-server.js) | provenance: key label/event by mesh root (NOTE: `agentmesh/run_id` is already emitted in Task metadata at [protocol.js:74](../../../src/a2a/protocol.js#L74), so `child_run_id` needs no producer change) |
| [src/dashboard/server.js](../../../src/dashboard/server.js) | scan `a2a-*` in `loadActivitySnapshot`; extend redaction to a2a on-disk-only fields |
| [src/dashboard/activity.js](../../../src/dashboard/activity.js) | split by `kind`; explicit a2a edges + events; edge dedupe (a2a supersedes inferred) |
| `src/log.js` | none (prefix param already supports `a2a`) |
| tests | new/updated per §8 |

## 10. Open decisions

- `summary_preview`: **kept** (capped + path-redacted, on-disk only) for greppable
  caller-side logs. Drop for strict YAGNI if undesired — it has no board effect.
- `child_run_id`: **already available** — `agentmesh/run_id` is emitted in Task
  metadata ([protocol.js:74](../../../src/a2a/protocol.js#L74)); the bridge reads
  `taskResult.metadata['agentmesh/run_id']`. No producer change (corrects an earlier
  draft that thought this needed adding).
