# Eval trio: `app` (driver) + `lib` (peer) + `docs` (middle hop)

Three reusable, standalone agent folders that cover the two scenarios a *pair*
cannot: **peer-selection** (≥2 distinct peers) and **two-hop-chain** (onward
delegation). For the single-hop behaviors (delegate / do-write / refusal / …)
use `examples/eval-pair/`.

Topology — `app` peers `[lib, docs]`; `docs` peers `[lib]`:

```
        app  (driver: routes to the right peer)
       /   \
     lib   docs
      ^      |
      └──────┘   docs onward-delegates to lib for shelf codes
```

Materialize a disposable, **doctor-wired** copy (real registry.json + the
`agentmesh_peerbridge` stdio MCP entry on both `app` and `docs`; transport is
stdio A2A `serve-a2a`, never changed):

```sh
node scripts/eval-trio-setup.mjs               # → a temp workspace
node scripts/eval-trio-setup.mjs ./ws --force  # → a named dir
```

Then `cd <ws>/app` and drive with `claude -p "…"`.

## Behavior coverage (maps to eval/scenarios/*)

| # | Scenario | Command (run in `app/`, phrased functionally) | Expect |
|---|----------|-----------------------------------------------|--------|
| 03 | peer-selection | `claude -p "What is the shelf code for The Dune Atlas? Exact code only."` | `app` picks **lib** (not docs) → `DUNE-7F` |
| 03 | peer-selection (other side) | `claude -p "Draft a one-line release note for The Dune Atlas."` | `app` picks **docs** (not lib) |
| 07 | two-hop-chain | `claude -p "Ask the docs agent to draft a release note for The Dune Atlas that includes its canonical shelf code."` | `app` → `docs` → (onward) → `lib`; the note carries `DUNE-7F` |

Verify the two-hop in the run logs: `app`'s log shows a delegation to `docs`, and
`docs`'s log under `<ws>/docs/.agent-mesh/logs` shows an onward delegation to
`lib`.

## Notes

- Phrase tasks **functionally** ("ask the docs agent…"), never by internal tool
  name — the headless MCP startup race can make first-turn tool enumeration
  flaky (see CLAUDE.md "MCP tools race the first model turn").
- `docs` deliberately owns no shelf data, forcing the onward hop; `lib`'s codes
  are fixed so assertions are stable.
