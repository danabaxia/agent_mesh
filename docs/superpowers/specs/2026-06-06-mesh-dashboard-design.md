# Mesh Dashboard — Design

- **Date:** 2026-06-06
- **Status:** Approved (design + 5-round Codex co-review, §11; round cap reached — final round applied post-cap, not re-verified); proceeding to writing-plans
- **Branch:** v1.0-development
- **Builds on:** the mesh model in `2026-06-06-mesh-onboarding-tool-design.md`
  (`mesh.json` manifest, per-agent anatomy, generated `registry.json`, `serve-a2a`).

## 1. Goal

A **local, read-only HTML dashboard** to see a whole mesh in one place and work
*through* it: the network, settings, and configuration; drill into each agent's
structure and files; and **talk to any agent as an entry point** into the mesh.
It observes and interacts — it never edits config (that stays in the CLI). It is
the human "single pane of glass" over the same files the runtime uses.

## 2. Chosen model (from the design session)

- **Read-only observability + entry-point interaction.** The dashboard reads the
  mesh; it does not write mesh/agent config. "Manage" = see/understand + chat.
- **3-pane IDE workbench:** **Explorer** (files) · **Board** (Kanban/Graph) ·
  **Desk** (file content *or* an agent's detail + live chat console).
  - All three panes are **collapsible** (header toggles `Files · Board · Desk`)
    and **horizontally resizable** (drag gutters). **When the Board is hidden, the
    Desk fills** the freed space (if the Desk is also hidden, the Explorer fills).
- **Explorer = IDE file tree** of the mesh + agent folders; clicking a file shows
  its content in the Desk. A **scope filter** (top bar) narrows the Explorer to
  the whole **Mesh** or one **agent**'s file system.
- **Type filter** (top bar, default **Agents**): **Agents · Skills · MCP** — drives
  the Board to list that resource type across the mesh.
- **Board:**
  - **Kanban** — one ungrouped card per resource (agent / skill / mcp).
  - **Graph** — the agent network. Edges are **directed** (`peers` = directed call
    permissions): A→B is an arrow; reciprocal peers render two-way; a peer to a
    missing/`served:false` agent is a **dangling/drift** edge. Node **status** (color) — served /
    disabled (`served:false`) / drift — is **independent of topology**: `isolated`
    (no edges) is a separate flag, so a *served* agent with empty `peers` is
    served-but-isolated, **not** "standalone". Node detail is on **hover
    (tooltip)**, not inline.
- **Desk = the colleague chat + inspector.** Click an agent (card/node/tree) →
  detail (identity, structure, peers) + a **live console** that talks to the agent
  (the entry point). Click a file → its content. The console is a **markdown
  canvas**: renders summaries, tables, images, code, blockquotes; capped to a
  ~760px reading column even when the Desk is full-width; tables size to content
  and offer **copy-as-TSV** (clean paste into Excel/email).
- **Aesthetic:** light "paper" theme; Fraunces (titles) + Spline Sans (UI) +
  JetBrains Mono (paths/data); single teal accent + status colors
  (teal=served, slate=standalone, amber=drift).

## 3. Architecture — served + data

A tiny **local read-only HTTP server**, zero-dependency (Node `http`), started by a
new CLI verb:

```
agent-mesh dashboard <mesh-root> [--port 7077] [--no-open]
```

It binds **`127.0.0.1` only** (never `0.0.0.0`), serves the self-contained static
frontend, and exposes a small JSON API over the mesh root.

### Read API (all read-only)

| Endpoint | Returns |
|---|---|
| `GET /api/mesh` | parsed `mesh.json` + derived **graph** (nodes = agents w/ status served/standalone/drift; edges = peers) + settings |
| `GET /api/agent/:name` | the agent's anatomy via `discoverAgentStructure` + AgentCard via `buildAgentCard` |
| `GET /api/tree?scope=mesh|<agent>` | the file tree for the scope (filtered) |
| `GET /api/file?path=…` | file **content**, text only, path-guarded (see §6) |
| `GET /api/skills` · `GET /api/mcps` | skills / MCP servers across the mesh, each labeled with **source** (global `mesh/` vs per-agent) and, for MCP, **grant status** (declared-only vs `readOnly`-granted) — never conflating global declared-only MCP with per-agent granted read-only |
| `GET /api/events` (SSE) | change notifications: server `fs.watch`es the mesh root (**debounced/coalesced**, with a **polling+mtime/checksum fallback** since `fs.watch` isn't reliably recursive/atomic cross-platform) → emits **coarse** events (changed *scope*, not secret paths; run through `isSensitivePath()`) so secret filenames never leak; client refetches. Poll fallback if SSE unavailable. |

**Reuses:** `manifest.js` (read `mesh.json`), `discoverAgentStructure`
(`src/agent-context.js`), `buildAgentCard` (`src/a2a/protocol.js`),
`isPathInsideRoot` (`src/path-guard.js`).

### Console (entry point) — the one place it *runs* an agent

`POST /api/agent/:name/message` `{ text, mode? }` (defaults `ask`) → the server brokers a real A2A
`message/send` to the agent via the existing `createA2AClient`
(`src/a2a/stdio-client.js`), spawning its `serve-a2a` from a **managed dashboard *caller* registry** — a
marker-validated registry of every `served:true` agent's spawn entry (canonical
root + projected env), generated and validated from `mesh.json`. (An agent's own
`registry.json` lists *its peers*, not itself, so it can't be the spawn source —
that was a v1 error.) The dashboard **refuses to spawn** if the caller registry is
stale/markerless or the target is not `served:true`. The runtime contract is
unchanged (PROJECT §1.7/§2.2): `message/send` returns **one final `Task`**, so the
console is **request→final-Task** in v1 (no mid-stream event protocol invented).
Onward-delegation is rendered **after** the Task returns, derived from its
`agentmesh/log_path`/metrics — the live "lighting" is a v2 nicety, not a fabricated
v1 stream.

**Console is `ask`-only in v1.** `do` would let model output write non-config
files under the agent root (PROJECT §1.4), breaking the "read-only dashboard"
promise — so `do` is **disabled** from the dashboard (deferred behind an explicit
future opt-in). The route **rejects any non-`ask` mode before spawning** with
`mode_disabled` — the dashboard never sends `do` to an agent. (`mode_disabled` is
added to the closed error set by the onboarding increment — a **prerequisite** of
this spec.) Surfaced in the Desk.

**Console resource limits:** request body cap (e.g. 16 KB, ≤ `MAX_TASK_CHARS`);
a small per-mesh concurrency cap with a queue; a request timeout aligned to the
runtime's; and cleanup on client disconnect — the brokered A2A client/process is
closed/killed if the HTTP request is abandoned. One in-flight send per agent
(serialized), mirroring the runtime's per-folder `do` serialization.

## 4. Components / file structure

| Module | Responsibility | Purity |
|---|---|---|
| `src/dashboard/server.js` | http server: static assets + JSON API + SSE + `fs.watch` | shell |
| `src/dashboard/data.js` | **pure**: snapshot (manifest + folder listings, loaded by `server.js`) → mesh/graph/skills/mcp view-model JSON. No I/O itself. | **pure** |
| `src/dashboard/console.js` | broker A2A `message/send` (caller registry of served agents) → return the **final Task**; derive delegation from its log/metrics | shell |
| `src/dashboard/public/` | self-contained frontend (`index.html`, `app.js`, `app.css`) | asset |
| `src/cli.js` (extend) | `dashboard` verb | shell |

`server.js` does all I/O (reads the manifest + folder snapshots); `data.js` is a
pure snapshot→view-model transform, so the rendering data is unit-testable without
a running server or filesystem.

## 5. Data flow

```
browser ──GET /api/mesh,/tree,/agent,/file──▶ server ──reads──▶ mesh.json + agent folders
   ▲                                            │
   └──────────── JSON / file content ───────────┘
browser ──POST /api/agent/:n/message──▶ server ──A2A message/send──▶ agent serve-a2a ──▶ worker
   ◀──────── one final Task (delegation derived from its log/metrics) ───────┘
fs.watch(mesh root) ──change──▶ SSE /api/events ──▶ browser refetches the affected view
```

## 6. Security (read-only, local, sanitized)

- **Local bind + capability cookie (concrete bootstrap).** A localhost endpoint
  that *runs agents* is reachable by any browser page (DNS-rebinding / drive-by
  localhost), so "localhost = safe" is false. **Bootstrap (server-side):** the server
  mints a one-time token and opens `…/?t=<token>`; **`GET /?t=` validates the token
  server-side, sets the `SameSite=Strict`, `HttpOnly`, host-only cookie via
  `Set-Cookie`, and 302-redirects to the clean app URL** — so the HTML and all
  assets load only *after* the cookie exists (no inline-script exchange, no
  CSP/asset deadlock); the redirect drops the token from the URL/history. Every
  subsequent
  request — static assets, API `fetch` (`credentials:'same-origin'`), and
  **`EventSource`** (can't set headers but *does* send cookies) — is then
  authenticated by that cookie **uniformly**. **CSRF/transport guards:**
  `SameSite=Strict` is **not port-scoped**, so a same-host *different-port* page
  could still attach the cookie — therefore a **same-origin gate applies to *every*
  authenticated route** (assets, API GET, SSE, console POST): require
  `Sec-Fetch-Site: same-origin` (or exact-`Origin` match to the listener origin),
  reject any request whose parsed `Host` authority isn't `{127.0.0.1, localhost}`
  at the listener port, and send `X-Content-Type-Options: nosniff`. The console
  `POST` additionally requires `Content-Type: application/json` and `POST`. **Leak controls:** `Referrer-Policy: no-referrer` + strict CSP
  (`default-src 'self'`; `img-src 'self'`) so the token can't leak via referrer and
  **remote images can't auto-fetch/exfiltrate** — agent-output `https:` images are
  NOT auto-loaded; they render as inert **click-to-load** links. No write/exec endpoints
  except the console (runs only mesh agents). Tested across assets, fetch, and SSE,
  plus cross-origin / wrong-host / no-cookie (all refused).
- **File API + tree API share one denylist/redaction predicate.** `path` is
  resolved and must satisfy `isPathInsideRoot(meshRoot, path)` (symlink +
  missing-segment safe); outside-root requests are refused. A single
  `isSensitivePath()` predicate — concrete patterns: `.git/`, `.env*`, `*.pem`,
  `*.key`, `id_rsa*`, `*secret*`, `*credential*`, `node_modules/`, build dirs — is
  applied to **both** `/api/file` (deny) **and** `/api/tree` (omit, so secret
  *filenames* don't leak), and to symlinks-resolving-to-secrets. The file API
  returns **text only**, size-capped (e.g. 512 KB), non-text → metadata stub.
- **Agent-root containment.** Every `agents[].root` in `mesh.json` is canonicalized
  and must satisfy `isPathInsideRoot(meshRoot, agentRoot)` **before any read**
  (`/api/tree?scope=<agent>`, `/api/agent/:name`) **or console spawn** — a manifest
  whose root escapes the mesh is marked **drift/denied**, never read or run. Tested
  with a root-escape manifest.
- **Output sanitization (XSS + injection).** File contents and agent console
  output are untrusted (file = anything; agent output = model-generated). The
  markdown→HTML renderer uses a **safe subset**: HTML-escape all text, **no raw
  HTML passthrough**, `link` URLs restricted to **`http(s)` only** (no
  `data:`/`javascript:`/protocol-obfuscation), no `on*` handlers, and **remote
  images are never auto-fetched** — an `https:` image in agent output renders as an
  inert click-to-load link (enforced by `img-src 'self'`), since a remote image URL
  is an exfiltration channel for untrusted model output. **CSV/TSV formula injection:** when
  copying a table, any cell beginning `=`,`+`,`-`,`@` is prefixed with `'` so it
  pastes as text, not a live Excel formula. First-class, with explicit tests.

## 7. Error handling

- Agent not `served` / spawn fails / times out → the Desk shows a structured error
  (reusing the runtime's failure-as-data); the mesh view marks the node.
- File not found / too large / denied → explicit Desk message, never a blank panel.
- SSE drop → client falls back to periodic poll.

## 8. Testing

- **Pure units (hermetic):** `data.js` builds correct mesh/graph (edges from
  `peers`, standalone = no edges), skills/mcp aggregation, agent anatomy JSON.
- **Server API (tmp mesh):** `/api/file` serves an in-root file and **refuses**
  an out-of-root path and a secret file (`.env`); `/api/mesh` shape; SSE emits on
  a file change.
- **Console (stubbed serve-a2a):** `POST message` brokers `message/send` and
  returns the final Task; a non-`ask` `mode` is **rejected at the route** with
  `mode_disabled` before any spawn.
- **Sanitization:** file/agent-output with `<script>`/`onerror=`/`javascript:`/
  `data:` renders inert (escaped, URLs dropped); an `https:` image does **not**
  auto-fetch (rendered as inert click-to-load); a table cell starting
  `=`/`+`/`-`/`@` is `'`-prefixed in copied TSV (formula-injection).
- **Auth/CSRF:** `GET /?t=` sets the cookie server-side and 302s to the clean URL,
  so the **first asset load is authenticated** (no deadlock); a same-host
  **cross-port** origin (`localhost:OTHER`) is refused on GET/SSE/POST alike;
  thereafter asset, `fetch`, and
  `EventSource` requests without the cookie, with a wrong `Host`/port, or a
  cross-origin console `POST` are all **refused**; only same-origin cookied
  requests pass.
- **Secret redaction:** `/api/file` denies and `/api/tree` **omits** `.env`/key
  files (no filename leak); a symlink resolving to a secret is denied.
- **Registry safety:** the console spawns only from the marker-validated **caller
  registry** of `served:true` agents, validated against `mesh.json`; it **refuses**
  a stale/markerless caller registry and a non-`served` target.
- **Agent-root escape:** a `mesh.json` `agents[].root` resolving outside the mesh
  root is denied for read and spawn.
- **Directed edges + status/topology:** one-way, reciprocal, and dangling
  (`served:false`/missing) peers render correctly; a **served agent with empty
  `peers`** shows as served + `isolated` (not "standalone") — status and topology
  are separate (§2).
- **SSE redaction:** a change to a secret file (`.env`) emits a coarse event that
  does **not** leak the path.
- **Console lifecycle:** oversized body rejected; parallel sends serialize/queue;
  an abandoned request closes/kills the brokered client.
- **Opt-in real-`claude` e2e** (`AGENT_MESH_E2E=1`): dashboard console → real
  agent → final Task rendered (ask-only).

## 9. Build increments

1. **Read-only shell** — `dashboard` CLI + `server.js` + `data.js` + the static
   3-pane frontend rendering **real** data (Explorer/scope filter, Board
   Kanban/Graph, Desk file content + agent detail), path-guarded file API,
   sanitized rendering. (No live chat yet.)
2. **The Desk console** — `console.js` A2A brokering (caller registry) returning
   the **final Task** + post-hoc delegation rendering from its log/metrics +
   `mode_disabled` handling; the markdown canvas (tables/images/code,
   reading-column, copy-as-TSV). SSE is used **only** for `/api/events` file refresh.
3. **Live + filters polish** — `fs.watch` SSE refresh; Skills/MCP type filters;
   graph hover tooltips; collapsible/resizable panes persisted.

## 10. Scope / non-goals

**In scope:** local read-only dashboard (Explorer/Board/Desk), scope + type
filters, Kanban + directed interaction Graph, Desk file viewer + **ask-only** A2A
console (entry point, capability token + CSRF guards), markdown canvas (safe
subset), shared path-guard/secret-redaction + sanitization, `fs.watch` live refresh.

**Out of scope (left room for):** editing mesh/agent config from the browser
(control plane — explicitly deferred; config stays in the CLI); auth / remote /
multi-user / non-localhost serving; running arbitrary commands; a heavyweight
frontend framework or build step (the frontend is hand-authored, self-contained,
zero-dep to match the project); HTTP(S) A2A transport.

## 11. Review log — codex-spec-review (independent Codex cross-review)

Run via the `codex-spec-review` skill (`codex exec -s read-only`, gpt-5.5). All
findings each round were judged valid and fixed (no rebuttals). Actionable-finding
trajectory: **12 → 4 → 2 → 2 → 3**. The 5-round cap was reached without a clean
`APPROVED`; the final 3 (round-5) fixes were applied post-cap and are **not yet
Codex-reverified** — surfaced here and in the walkthrough for the author to accept
or run one confirming round.

- **R1 (12):** localhost auth/CSRF; SSE-vs-`message/send` contract; `do`-mode
  side-effect boundary; spawn-source vs registry shape; `mode_disabled` not in the
  error set; secret leakage via `/api/tree`; sanitizer `data:`/remote + TSV
  formula-injection; directed edges; console lifecycle; `fs.watch` reliability;
  skills/mcp aggregation labels; `data.js` purity. → all fixed.
- **R2 (4):** console must spawn from a **caller** registry of served agents (not an
  agent's peer registry); final-Task contract leftovers; agent-root containment
  before any read/spawn; `Host` authority+port. → all fixed.
- **R3 (2):** concrete token→cookie bootstrap transport (assets/fetch/SSE); console
  `{text, mode?}` contract rejecting non-`ask` with `mode_disabled`. → all fixed.
- **R4 (2):** server-side cookie exchange (no first-load/CSP deadlock); `img-src
  'self'` only — remote images inert click-to-load (close exfiltration). → fixed.
- **R5 (3 — cap):** uniform same-origin gate on all routes (`SameSite` not
  port-scoped) + `nosniff`; SSE payload secret-path redaction; node **status**
  decoupled from **topology** (`isolated` flag; served-with-empty-peers ≠
  standalone). → applied post-cap, pending reconfirmation.
