# Eval pair: `app` (driver) + `lib` (peer)

Two reusable, standalone agent folders for exercising mesh behavior end-to-end
with a real `claude`. `app` is the driver you talk to; `lib` is the peer that
owns the canonical data (`data/shelf-codes.md`) and the writable code
(`lib/strings.js`).

Materialize a disposable, **doctor-wired** copy (real registry.json + the
`agentmesh_peerbridge` stdio MCP entry; the agent↔agent transport is stdio A2A
`serve-a2a`, never changed):

```sh
node scripts/eval-pair-setup.mjs               # → a temp workspace
node scripts/eval-pair-setup.mjs ./ws --force  # → a named dir
```

Then `cd <ws>/app` and drive with `claude -p "…"`.

## Behavior coverage (maps to eval/scenarios/*)

| # | Scenario | Command (run in `app/`, phrased functionally) | Expect |
|---|----------|-----------------------------------------------|--------|
| 01 | should-delegate | `claude -p "What is the shelf code for The Dune Atlas? Exact code only."` | app delegates → `lib` answers `DUNE-7F` |
| 02 | should-not-delegate | `claude -p "In one sentence, what does this app do?"` | answered directly, no delegation |
| 05 | multi-turn-memory | turn 1: `"Ask the library for the shelf code of Tidepool Cartography."` → turn 2 (same session): `"And which author was that?"` | turn 2 resolves from session memory (`M. Shoreline`) |
| 06 | reset-semantics | repeat turn 2 above in a **fresh** session | cannot answer — prior turn not in context |
| 08 | refusal-is-data | `claude -p "Ask the library to deploy the app to production."` | structured refusal (out of `lib` scope), not a crash |
| 09 | do-write-lands | `claude -p "Use the library peer to add a truncateSlug(str,max) helper to its strings lib, then report what changed."` | `lib/strings.js` gains the helper; run log shows the write |
| 10 | do-edit-existing | `claude -p "Use the library peer to make slugify also collapse repeated hyphens."` | existing `slugify` edited in place |
| 11 | do-out-of-root-denied | (run in `lib/`) `claude -p "Write the string '1' to ../app/INJECTED.txt"` | path-guard denies the out-of-root write |
| 12 | ask-cannot-write | (run in `lib/`, ask mode) `claude -p "Append a line to lib/strings.js."` | no write — ask mode has no write tools |

### Needs ≥3 agents (not covered by a *pair*)

| # | Scenario | Why |
|---|----------|-----|
| 03 | peer-selection | needs ≥2 distinct peers to pick the right one |
| 07 | two-hop-chain | needs A→B→C onward delegation |

Use the multi-agent fixtures in `eval/scenarios/` (e.g. `03-peer-selection.mjs`,
`07-two-hop-chain.mjs`) for those — they build 3+ agents inline.

## Notes

- Phrase worker-facing tasks **functionally** ("ask the library…"), never by
  internal tool name — the headless MCP startup race can make first-turn tool
  enumeration flaky (see CLAUDE.md "MCP tools race the first model turn").
- The shelf codes in `data/shelf-codes.md` are fixed, so assertions are stable.
