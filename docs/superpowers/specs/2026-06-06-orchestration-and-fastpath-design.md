# Light Orchestration + Deterministic Primary-Tool Fast-Path — Design

## 1. Goal & evidence

A trivial mesh task ("find Dune") takes **~46s**. Measured breakdown:

| Test | Time | Isolates |
|---|---|---|
| trivial `claude -p`, default model | 3.0s | cold start + minimal turn |
| trivial `claude -p`, Haiku | 3.6s | model tier delta → **none** |
| turn + 1 MCP + tool use | 8.5s | base + 1 MCP start + tool loop |
| real library hop (in mesh) | 31.9s | base + **2 MCP servers** + big prompt + multi-turn |
| full app→library | 46s | app loop **blocks on** library's 32s loop |

Conclusion: the cost is **structural — two full agentic loops in series**, each paying
per-task MCP cold-starts and multi-turn round-trips. **Model tiering is a dead end**
(measured). The fix is to (a) let tool-shaped agents answer via their primary tool
with **no LLM turn**, and (b) put a **light orchestrator** in front that routes a
task to the cheapest path (direct tool vs. full agent). Target: ~46s → **~8-10s**
(one routing decision + one tool call), or ~5s when the route is rule-matched.

## 2. Model & key decisions

- **Deterministic primary-tool agents (no LLM).** An agent may declare a
  `primaryTool` (one of its OWN `readOnly` `.mcp.json` servers). A task that
  arrives as a structured `toolCall` against that declared tool is executed
  directly — the agent's `serve-a2a` calls the MCP tool and returns the Task with
  **no `claude -p` worker**. (User decision: "deterministic primary-tool, no LLM".)
- **Orchestrator is an agent role (not the dashboard).** An agent opts into
  `role: "orchestrator"`; its runtime does *route-then-execute* instead of a single
  heavy worker loop. The console/driver just talks to it; orchestration stays
  inside the mesh model. (User decision.)
- **`toolCall` is an orchestrator-INTERNAL A2A path, NOT the worker bridge.**
  (R1/BLOCKER-1) The worker-visible peer bridge keeps its fixed model-facing args
  `{ peer, mode, task }` (the onward-delegation carve-out; `src/a2a/peer-bridge.js`).
  The orchestrator is *framework code* (the orchestrator agent's runtime), so it
  uses its **own** `createA2AClient` send and may attach `agentmesh/toolCall`
  metadata. A model-driven worker can never emit `toolCall` — it only ever sees
  `delegate_to_peer({peer,mode,task})`. So anti-spoof is preserved: the structured
  tool call is produced by framework routing, not by model output.
- **Hybrid routing.** Declared-intent **rules first** (zero LLM); ambiguous tasks
  fall back to **one structured LLM turn** that emits the route. (User decision.)
- **ask-only v1**, consistent with the onward-delegation carve-out. The fast-path
  and the orchestrator routing turn are read-only; `do` orchestration is a non-goal
  for v1.
- **Backward compatible / default-off.** Agents without `primaryTool` or
  `role:"orchestrator"` behave exactly as today (full agentic delegation). The
  `agentmesh/toolCall` metadata is optional: **absent → normal full-agent
  delegation** (default-off); **present but the receiver has no matching declared
  `primaryTool` → `mode_disabled`** (never silently ignored, never executed).
  (R1/MAJOR-3)

## 3. Declarations (agent.json `x-agentmesh`)

```jsonc
// A tool-shaped agent (e.g. library):
"x-agentmesh": {
  "modes": ["ask"],
  "primaryTool": {
    "server": "book-search",        // must be one of this agent's OWN .mcp.json readOnly servers
    "tool": "search_books",
    "argsSchema": { "query": "string" },   // shape the orchestrator must fill
    "intents": ["find book", "look up title", "catalog", "shelf"]  // routing hints
  }
}

// An orchestrator agent (e.g. app):
"x-agentmesh": {
  "modes": ["ask"],
  "role": "orchestrator"            // its runtime routes instead of running one heavy loop
}
```

`intents` and `argsSchema` are **untrusted declarative data** (like AGENT.md):
length-bounded, used only as routing hints / validation shape — never executed.

**Discovery path (R2/MAJOR-1).** The orchestrator must learn peers'
`primaryTool`/`intents` without reading peer local roots ad hoc. `buildAgentCard`
(`src/a2a/protocol.js`) is extended to expose a **sanitized**
`x-agentmesh.primaryTool` (server, tool, bounded `intents`, `argsSchema` shape —
*no* command/args/paths) alongside the existing `modes`. The orchestrator obtains
peer cards via the standard A2A `initialize` handshake over its managed registry —
the same channel it already uses to reach peers — so routing inputs are explicit,
sanitized, and testable. No new local-root scraping.

## 4. Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/orchestrator.js` | **new** route-then-execute for `role:"orchestrator"` agents: build a routing decision (rules → cheap LLM fallback), then call the chosen peer (fast-path `toolCall` or full delegate) | shell |
| `src/routing.js` | **new pure** routing core: given (task, peers+declared intents/primaryTools) → `{ target, route:"tool"\|"agent", toolCall?, task? , source:"rule"\|"llm-needed" }` for the rule pass; the LLM fallback is a thin shell around a structured `claude -p` turn | pure (rule pass) |
| `src/delegate.js` (extend) | **fast-path executor:** if the incoming task carries a valid `agentmesh/toolCall` matching the agent's declared `primaryTool` (ask-only), call the MCP tool directly **inside the existing run-log + change-detect envelope** and return the Task — skip the `claude -p` worker. Absent `toolCall` → unchanged. Present but undeclared/mismatched → `mode_disabled`. | shell |
| `src/a2a/protocol.js` | validate optional `agentmesh/toolCall` metadata shape; `buildAgentCard` exposes the **sanitized** `x-agentmesh.primaryTool` + `intents` (discovery, §3) | pure |
| `src/routing.js` (orchestrator side) | obtain peer cards via A2A `initialize` over the managed registry → routing inputs | shell |
| `src/a2a/stdio-server.js` (extend) | route an incoming `message/send` carrying `toolCall` to the fast-path executor | shell |

The worker-visible peer bridge (`src/a2a/peer-bridge.js`) is **unchanged** — it
keeps `{peer,mode,task}`. `agentmesh/toolCall` is emitted only by the orchestrator's
own `createA2AClient` send (framework code), never by a model worker.

## 5. Control / data flow

```
console → orchestrator agent (app, role:orchestrator)
  ├─ routing.js rule pass: task vs peers' declared intents
  │     match (e.g. "find … book") → { target: library, route: tool,
  │                                     toolCall: { tool: search_books, args: { query: "Dune" } } }
  │     no match → ONE structured `claude -p` turn → same shape (or route: agent)
  └─ execute (orchestrator's OWN createA2AClient send — framework code):
       route: tool  → A2A message/send to library WITH agentmesh/toolCall metadata
                         library serve-a2a → FAST-PATH executor:
                           validate toolCall.tool == declared primaryTool.tool, ask-only
                           run-log(start) → call book-search.search_books({query:"Dune"})
                             inside change-detect envelope [no claude -p] → run-log(finalize)
                           → Task("Dune — shelf 3")
                         (undeclared/mismatched toolCall → mode_disabled Task)
       route: agent → today's full delegation (worker loop) for tasks needing reasoning
  ← orchestrator returns the Task (optionally a 1-line format) to the user
```

Arg extraction: the rule pass does simple, declared extraction (strip a matched
intent prefix → `query`); the LLM fallback does robust extraction. Either way the
peer **validates** `args` against its `primaryTool.argsSchema` before calling.

## 6. Security & invariants

- **Fast-path is constrained to the declared primary tool.** The executor runs
  `toolCall.tool` **only if** it equals the agent's declared `primaryTool.tool`
  whose server is one of the agent's OWN `readOnly` `.mcp.json` servers. A
  mismatch / undeclared tool → `mode_disabled` (no execution). No arbitrary tool
  injection via metadata.
- **ask-only / read-only, but still audited (scoped to the agent root).**
  (R1/MAJOR-4, narrowed per R2/MAJOR-2) Skipping the worker must NOT skip the
  audit: the fast-path executor runs inside the **same `captureChangeState` →
  `computeFilesChanged` + run-log envelope** as a normal delegate, so a misbehaving
  "readOnly" tool that writes **inside the agent root** is still reported in
  `files_changed` (not assumed null). This does **not** claim broader detection:
  `readOnly` MCP is *author-vouched, not sandboxed* (PROJECT.md §1.6), and
  change-detect only covers the agent root — **out-of-root** MCP side effects are
  out of scope exactly as they are for a normal worker today (unchanged threat
  model; a real sandbox is a separate Phase-2 item). v1 stays ask-only; `do`
  orchestration deferred (non-goal).
- **Anti-spoof preserved.** `toolCall` is validated against the *declared*
  primaryTool + `argsSchema`; args are size-capped; intents are bounded untrusted
  data. Recursion/identity env still come only from process env.
- **Registry is still the only peer source** (`readManagedRegistry`), reused from
  onward delegation. The orchestrator routes only to marked peers.
- **Default-off.** No `primaryTool` → no fast-path (normal worker). No
  `role:"orchestrator"` → normal agent. Existing tests unaffected.
- **Observable.** Both the routing decision and the fast-path tool call write run
  logs (so the dynamic-board spec can narrate them); the fast-path log records
  `route:"tool"`, the chosen tool, and timing.

## 7. Error handling (failure-as-data)

- Undeclared/mismatched `toolCall` → `mode_disabled` Task (no execution).
- `argsSchema` validation failure → `bad_input` Task.
- MCP tool error → `internal` Task with `log_path`. **Timeout** → `status.state:
  "failed"` with **no** `error_code` (R1/MAJOR-5 — there is no `timeout` error code
  in the closed set; timeout maps via TaskState `failed`, same as `delegate.js`
  today). The closed `error_code` set is unchanged.
- Routing LLM fallback returns an unroutable/garbled decision → fall back to
  **full-agent delegation** (never fail the task just because routing was unsure).
- No peer matches → orchestrator answers "no capable peer" or, if it has its own
  tools, handles directly — never a blank.

## 8. Testing

- **routing.js (pure):** rule match on declared intents → correct target +
  extracted args; no match → `route:"llm-needed"`; ambiguous/multi-match → defined
  tie-break.
- **fast-path executor (hermetic, fake MCP):** valid `toolCall` matching
  primaryTool → tool called directly, **no worker spawned**, Task mapped, and a
  **run-log + change-detect** record is produced (audit envelope present);
  mismatched/undeclared tool → `mode_disabled`, no call; bad args → `bad_input`; a
  "readOnly" tool that writes a file **inside the agent root** → `files_changed`
  is **non-null** (in-root audit not bypassed; out-of-root is out of scope).
- **default-off:** **absent** `toolCall` → normal worker (today's behavior);
  agent without `primaryTool` receiving a `toolCall` → `mode_disabled` (not ignored).
- **orchestrator (fake peers):** rule route → fast-path peer with `toolCall`;
  unroutable → LLM fallback shape; LLM garbled → full-agent fallback.
- **role default-off:** agent without `role:"orchestrator"` delegates as today
  (no routing layer).
- **security:** `toolCall` naming a non-primary/undeclared tool is refused; args
  over cap refused.
- **opt-in real-`claude` e2e:** console → app(orchestrator) → library fast-path →
  "shelf 3", asserting **wall-clock well under the 46s baseline** and that the
  library log shows `route:"tool"` (no worker turn).

## 9. Build increments

1. **Fast-path executor** — `primaryTool` declaration + `agentmesh/toolCall`
   validation + delegate.js direct-tool execution + tests. (Library answers in
   one tool call when called with a structured `toolCall`.)
2. **Routing core** — `routing.js` rule pass (pure) + the cheap structured LLM
   fallback + tests.
3. **Orchestrator role + wiring** — `orchestrator.js`, `role:"orchestrator"`
   handling in serve-a2a, the orchestrator's own `createA2AClient` send that
   attaches `agentmesh/toolCall` (the worker bridge is untouched); e2e + demo
   re-validation with timing.

## 10. Non-goals (v1)

- `do` orchestration / fast-path writes (ask-only v1; same gate as onward `do`).
- Multi-peer fan-out / planning DAGs (single route per task in v1).
- Model tiering (measured: no benefit).
- Replacing the full-agent path — it remains for tasks that need reasoning.

## Review log

- **R0 (draft):** initial design.
- **R1 (codex; 2 BLOCKER / 3 MAJOR on this spec — all accepted):**
  - BLOCKER-1 (toolCall on the worker bridge breaks the `{peer,mode,task}`
    carve-out) → `agentmesh/toolCall` moved to the **orchestrator-internal**
    `createA2AClient` send (framework code); the worker bridge is unchanged
    (§2/§4/§5/§9).
  - BLOCKER-2 (`protectedEnv` ignored in `peerEnv`) → **fixed in shipped code**
    (commit: peerEnv now applies `protectedEnv`) + regression test; this spec
    relies on that fix.
  - MAJOR-3 (default-off inconsistency) → absent `toolCall` = normal delegation;
    present-but-undeclared = `mode_disabled` (§2/§6/§8).
  - MAJOR-4 (fast-path skips change-detect audit) → fast-path runs inside the
    same run-log + change-detect envelope (§4/§6/§8).
  - MAJOR-5 (`timeout` not in the closed error set) → timeout = `status.state:
    "failed"`, no new error_code (§7).
- **R2 (codex; 2 MAJOR on this spec — accepted):**
  - MAJOR-1 (no concrete discovery for primaryTool/intents) → `buildAgentCard`
    exposes a **sanitized** `x-agentmesh.primaryTool`+`intents`; orchestrator
    discovers via A2A `initialize` (§3/§4).
  - MAJOR-2 (audit claim too broad) → narrowed to **in-root** writes; out-of-root
    MCP side effects explicitly out of scope (unchanged threat model) (§6/§8).
- **R3 (codex):** `VERDICT: APPROVED` — no actionable findings. **Consensus reached** (8 → 4 → 0 across three rounds).
