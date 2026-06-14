# Session Log + Session Management (+ Result Canvas) — Design

## 1. Goal

Give the dashboard a durable, browsable record of **every claude session per
agent**, a polished **result canvas** that renders an agent's rich output
(markdown, images, charts, tables, lists, code), and **light session
management** (resume / open-in-terminal / copy), all behind the privileged
`--allow-shell` gate.

User's words: *"log all CLI conversation records and session management"* and
*"the conversation window should be a refined canvas — images, charts, lists,
dynamic rendering — designed as an independent, well-bounded unit."*

This supersedes the lean, flaky read-only live-mirror (`src/dashboard/session-mirror.js`
in its current form — no replay buffer), which is rewritten here.

### Three layers
1. **Session index (Part A data)** — discover + index all sessions for an agent.
2. **Session management (Part B)** — resume / open-in-terminal / copy, guarded (within
   the documented limits of §6) by the existing single-active lease.
3. **Result Canvas (shared UI unit)** — the rich renderer, reused by the log
   viewer and the live/driven views.

## 2. Model & key decisions (all user-confirmed)

- **Hybrid logging.** The mesh keeps a **lightweight, durable index** of sessions
  but renders transcript **content on demand** from Claude Code's own JSONL
  (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`). No content duplication.
- **Scope = any session run in the agent's folder.** Sessions are discovered from
  the agent's `~/.claude/projects` dir — including ones started outside the mesh.
- **Provenance via an append-only event log, not a lossy id→source map
  (R1/MAJOR-3).** The mesh appends management events to
  `~/.agent-mesh/sessions/<meshHash>/events.jsonl`:
  `{ at, kind:'create'|'select'|'open', source:'dashboard'|'terminal', terminalApp?,
  platform?, agentKey, sessionId, transcriptPath }` — `create` = the mesh started a
  **brand-new** session id (only the dashboard runner does this, via
  `--session-id`); `select` = dashboard selected an existing session; `open` =
  terminal opened an existing session via `--resume`. (source `terminal` covers
  macOS Terminal/iTerm + Windows PowerShell/Windows Terminal/cmd — `terminalApp`
  records which.) The index derives per session (R5/MAJOR): **`originSource`** =
  the source of the session's **`create`** event, or **`'cli'`** if it has none
  (created outside the mesh) — `select`/`open` **never** change origin; and
  **`lastManagedBy`** = the source of the **most recent** event (any kind). So an
  externally-created session, selected in the dashboard, then opened in a terminal
  shows `origin: cli · last: terminal (pwsh)`.
- **Part B v1 = read + light management, with honest lease scope (R1/BLOCKER-2 +
  R3/MAJOR-2).** view / copy block / copy session id / **Resume in dashboard** /
  **Open in terminal**.
  - **"Resume in dashboard" is pure selection — no lease, no turn.** It sets the
    agent's **active dashboard session** to `:id` and returns the new
    `{ activeId, rev }` (a monotonically increasing selection revision). The lease
    is held **only while a turn actually runs**: `POST /session/message` carries an
    `expectedActiveId` (the id the client selected); the runner takes the
    single-active lease, verifies `expectedActiveId === currentActiveId` (else
    `409 active_changed` — guards the select→message race), then drives `--resume
    <activeId>` ask-only. So selection is cheap/raceless; the lease lifetime is one
    turn (R3/MAJOR-2).
  - **Open in terminal is NOT single-active-coordinated in v1.** The launcher can't
    yet take/release the shared lease (deferred "terminal joins the canonical
    session" increment). v1 only **records** the launch to `events.jsonl` and warns
    that a terminal session runs **outside** dashboard single-active coordination.
    No false mutual-exclusion guarantee. (Cross-process terminal leasing → future
    spec.)
  - **No destructive ops** (no delete/rename/archive) in v1.
- **Live, with a real, session-keyed replay buffer on a stable cursor
  (R1/MAJOR-4 + R2/MAJOR-1).** New sessions and new turns appear live. The cursor
  is **transcript-derived, not a runtime counter**: `seq` = the 1-based **source
  line index** in the transcript JSONL (append-only ⇒ stable across reloads,
  pagination, tailer restarts). **The wire unit is a whole line, atomic
  (R2/MAJOR-1 + R3/MAJOR-1):** every delivery — one SSE event, or one element of a
  `/transcript` window — is a **line record** `{ seq, events:[…] }` carrying *all*
  events parsed from that line, so a multi-event line can never be half-delivered
  or duplicated across a reconnect/page boundary. `/transcript`, `/stream` (`id:`/
  `Last-Event-ID`), and the buffer all use this one cursor. The rewritten mirror
  keys its ring buffer **by session id (transcript)**, tracks `bufferStartSeq`
  (first line still buffered), and emits `replay_gap` only when the reconnect's
  `Last-Event-ID + 1 < bufferStartSeq` (i.e. a real hole; `Last-Event-ID ==
  bufferStartSeq − 1` is still replayable — R3/MINOR) or the offset is beyond EOF
  after truncation/rotation → client full-reloads via windowed `/transcript`.
- **Cross-platform: Windows + macOS, incl. PowerShell (user requirement).** Every
  OS-touching part is platform-aware (§ Cross-platform): the transcript project-dir
  encoding, the liveness probe, the process-tree kill, and the "Open in terminal"
  launcher (macOS Terminal/iTerm; Windows **PowerShell**/Windows Terminal/cmd). The
  render layer (result canvas / items) is already platform-neutral.
- **Gated behind `--allow-shell` + auth.** The whole feature (even read-only
  browsing) is privileged: transcripts can contain secrets/file contents, and
  resume drives claude. Same gate as the native entry point; streamed/returned
  content passes `redactSessionEvent`.
- **Bounded everywhere (R1/MAJOR-6).** Transcript reads are **windowed/paginated**
  by turn with hard caps (max events/response, max file bytes scanned); the canvas
  renders windows + "load earlier", with a DOM node cap.
- **Canvas visual (locked via visual companion):** Layout **B** (session-primary
  rail + resizable gutter + canvas + ⛶ fullscreen/presentation); **light paper
  theme** (`--paper #f5f3ec`, `--surface #fffefb`, `--ink #1c1b17`, `--teal
  #0f7a6b`; Fraunces/Spline Sans/JetBrains Mono); **per-block ⧉ copy** (text/table/
  list/code → clipboard text; image/chart → PNG); render templates (rich text,
  image card, table, **bar + line inline SVG**, metric cards, list, code, collapsed
  tool rows); **wide-rule C** (prose locked to ~660px measure centered; large
  artifacts break out to ~900px, still centered; presentation widens breakout +
  hides rail).
- **Images via an SSRF-hardened local proxy (R1/BLOCKER-1).** `GET /api/img?url=`
  fetches the remote image server-side and streams it same-origin (`img-src` stays
  `'self'`). Hardening in §6. **Remote SVG is rejected** (it is active content);
  generated chart SVG is client-owned/inline, never proxied (R1/MAJOR-8).
- **Reuse, don't re-invent.** Reuse `session-events.js`
  (`parseTranscriptLine`/`redactSessionEvent`), `session-lease.js`,
  `session-store.js`, `session-runner.js` (resume), `delegate-invocation.js`
  ask-mode builder. Resume in the dashboard continues a session **ask-only**.

## 3. Components

### Backend (`src/dashboard/`)
| Module | Responsibility | Purity |
|---|---|---|
| `session-index.js` | **new.** `encodeProjectDir(canonicalRoot, platform)` is **platform-aware** (R2/user): macOS/Linux replace `/`+`.` → `-`; Windows encode the `C:\…` cwd per Claude Code's Windows scheme; **fallback** — if the computed dir is absent, scan `~/.claude/projects` for the entry whose decoded form matches the canonical root, so we never miss the real dir. `listSessions(agentRoot)` → for the agent's project dir, returns `[{ id, originSource, lastManagedBy, startedAt, endedAt, turns, firstPrompt, active, transcriptPath }]`. **Accuracy (R1/MAJOR-5 + R4/MAJOR-3) — two independent caps:** (1) the **list
preview** (`turns`/`firstPrompt`/`startedAt`/`endedAt`) comes from a once-per-file
scan **byte-capped** at `MAX_SCAN_BYTES`, cached by `(path,size,mtime)`, re-scanned
only on change → exact for files ≤ cap, `turnsApprox:true` beyond. (2) the
**cursor** (line index / byte offset) is **never** capped: line indices come from a
cheap full **newline scan** (no JSON parsing), so `/transcript` and `/stream` can
always return exact `seq`s and initialize SSE ids correctly **even for oversized
externally-created transcripts** — only the preview degrades, never the cursor. `active` = transcript `mtime` within `ACTIVE_WINDOW_MS` **and**, for dashboard-origin, the lease being live (else heuristic mtime-fresh). Provenance from `events.jsonl` (`readEvents`/`recordEvent`). `resolveTranscript(agentRoot, id)` validates the id is a UUID, looks it up **only via the index**, and realpath-checks the file under the expected project dir (R1/MAJOR-9). | mixed (pure scan + thin fs) |
| `session-mirror.js` | **rewrite.** Tailer with a **per-session ring buffer keyed by session id**, `bufferStartSeq`, per-subscriber cursor, where **`seq` = transcript line index** and the delivered unit is a **line record** `{ seq, events:[…] }` (atomic per line, R3/MAJOR-1). `subscribe(sessionId, transcriptPath, fn, lastSeq)` → replays buffered line-records with `seq > lastSeq`; emits `{type:'replay_gap'}` only when `lastSeq + 1 < bufferStartSeq` (R3/MINOR) or offset > EOF (truncation); then streams appended lines, counting line index from a tracked byte offset. Parses via `parseTranscriptLine`, scrubs via `redactSessionEvent`. Lazy start / stop on last unsubscribe. Handles partial trailing lines + truncation/rotation (offset reset → `replay_gap`). | shell over pure parse |
| `img-proxy.js` | **new, SSRF-hardened (R1/BLOCKER-1).** `fetchRemoteImage(url, deps)`: require `https:`; **resolve DNS, reject if ANY resolved address is private/loopback/link-local/ULA/IPv4-mapped-IPv6/CGNAT or a numeric-literal host**; **connect to the pinned vetted IP** (custom `lookup`/agent so `fetch` can't re-resolve → no DNS rebinding); **manually follow ≤2 redirects, re-validating URL + re-resolving + re-pinning each hop**; require response `content-type` ∈ a **raster allowlist** (`image/png|jpeg|gif|webp|avif`) — **reject `image/svg+xml`** — **AND verify the actual bytes' magic number matches a raster format (don't trust upstream Content-Type; R2/MAJOR-4)**, rejecting mislabeled SVG/HTML; the dashboard re-serves with the **sniffed** type + `X-Content-Type-Options: nosniff`; cap bytes (≤5 MB) + timeout. Host allowlist configurable. Pure over injected `dns.lookup`/`fetch`. | mixed |
| `session-runner.js` | **extend.** `setActiveSession(agentKey, id)` → make `:id` the agent's **active dashboard session** (writes the canonical-id store + a `rev`++ + `recordEvent({kind:'select',source:'dashboard'})`); **no lease, no turn** (R2/MAJOR-3, R3/MAJOR-2). `runTurn({ expectedActiveId })` takes the single-active lease, **rejects `active_changed`** if `expectedActiveId !== currentActiveId`, then drives `--resume <activeId>` ask-only. Lease lifetime = one turn. When there is **no** active session, the first turn creates one (`--session-id`) and records `{kind:'create',source:'dashboard'}` (the only producer of `create`). | shell |
| `session-events.js` | **reuse** `parseTranscriptLine`, `redactSessionEvent`. | pure |
| `server.js` | **extend.** Routes in §4; `/api/img`; capability rename in §4. All behind `--allow-shell` + auth + membership + containment, gate-before-side-effect; `:id` resolved only via `session-index.resolveTranscript` (R1/MAJOR-9). | shell |

### Frontend (`src/dashboard/public/`)
| Module | Responsibility |
|---|---|
| `result-canvas.js` | **new — the independent unit.** `createResultCanvas(rootEl)` → `{ render(event), renderAll(events), clear(), setMode('inline'\|'presentation'), destroy() }`. Maps normalized events → rich blocks; per-block **⧉ copy**; wide-rule C; rewrites remote `<img>`→`/api/img`. **Sanitizer contract (R1/MAJOR-7):** rendering **escapes all text, passes through NO raw HTML**, allows only safe URL schemes (`https:`, `/api/img`, mailto) — `javascript:`/`data:`/unknown → inert; the `chart` fence is parsed against a **bounded numeric JSON schema** (labels=strings, values=numbers, type∈{bar,line}, length cap) and rendered as SVG with escaped labels. No transport knowledge (pure render unit). |
| `session-log.js` | **new.** B-layout controller: session rail (`/session/list`, session-primary, expandable turns), resizable gutter, fullscreen toggle, a `result-canvas` instance; opening a past session → windowed `/transcript` (+ "load earlier"); active session → `/stream` (handles `replay_gap` → full reload); Resume / Open-in-terminal / copy-id controls. |
| `app.js`/`app.css`/`index.html` | **extend.** Replace the lean native-session + flaky mirror panels with the `session-log` view (shown when `sessionLogEnabled`); add canvas/rail/chart/copy CSS in the paper theme. |

## 4. Routes, capability & migration (R1/MINOR-12)

New routes (all `--allow-shell`+auth). The cursor everywhere is the transcript
**line index** (§2 stable cursor):
- `GET  /api/agent/:name/session/list` → index rows.
- `GET  /api/agent/:name/session/:id/transcript?beforeSeq=&limit=` → **windowed
  line records** `[{ seq, events:[…] }]` (parsed+redacted; `beforeSeq` = line
  index; newest-last), with `hasMore`/`nextCursor` (a line index).
- `GET  /api/agent/:name/session/:id/stream` → live SSE; each event is a line
  record `{ seq, events:[…] }`; `id:` = `seq`; reconnect via `Last-Event-ID`;
  `replay_gap` on real hole/truncation.
- `POST /api/agent/:name/session/:id/resume` → **pure selection**: set the agent's
  active dashboard session to `:id` (`setActiveSession`; records `select`); returns
  `{ ok, activeId, rev }`. No lease, no turn (R3/MAJOR-2).
- `POST /api/agent/:name/session/message { text, expectedActiveId }` → drives one
  ask-only turn on the active session **under the lease**; `409 active_changed` if
  `expectedActiveId` ≠ current; `409 session_busy` if the lease is held.
- `POST /api/agent/:name/session/stop` → kill the in-flight turn's process tree,
  wait, token-checked-release the lease, emit a terminal event (the retained
  driven-session control).
- `POST /api/agent/:name/session/:id/open-terminal` → **resolve `:id` via the
  index, then build a launch plan that runs `claude --resume <id>`** through the
  existing cross-platform launcher (macOS Terminal/iTerm; Windows PowerShell/
  Windows Terminal/cmd); record `events.jsonl {kind:'open',source:'terminal',
  terminalApp,platform}` (it resumes an existing id — `open`, not `create`);
  return the plan + a one-line **warning** that this
  session runs **outside** dashboard single-active coordination. **No lease**
  (R2/MAJOR-2, R1/BLOCKER-2).
- `GET  /api/img?url=` → hardened image proxy.

**Migration (R4/MINOR):** the **canonical** route set is exactly the seven
`/api/agent/:name/session/*` + `/api/img` routes listed above — `list`,
`:id/transcript`, `:id/stream`, `:id/resume`, `:id/open-terminal`, `message`,
`stop`. `message` and `stop` are **retained, canonical** (drive/stop a turn on the
active session). The lean `GET /session/stream` and `GET /session/mirror` routes
are **removed outright** (no aliases). Capability is unified to
**`sessionLogEnabled`** (remove `sessionEnabled` + `mirrorEnabled`). The retired
lean `session-mirror.js` behavior is fully subsumed by the rewritten one.

## 5. The Result Canvas unit (detail)

- **Input contract:** normalized events `{ type, …fields, seq }` (`user_text`,
  `text`, `tool_use`, `tool_result`, `init`, `turn_done`, `error`, `raw`,
  `replay_gap`). Inside `text`/`tool_result` markdown the canvas upgrades safe
  fenced structures to rich blocks: images `![alt](https…)`, GFM tables, code
  fences, and a mesh-convention ` ```chart ` JSON block (bounded schema → SVG).
  Unknown/unsafe → escaped plain text.
- **Blocks:** user bubble, prose (Fraunces headings), collapsed tool row (expand
  for args/result), image card, table, bar-svg, line-svg, metric row, list, code.
  Each `.blk` with hover `⧉` copy.
- **Copy:** text/table/list/code → `clipboard.writeText`; image/chart → node →
  `<canvas>` `toBlob` → `clipboard.write` PNG; fallback to copying the source.
- **Safety:** see §3 sanitizer contract — escaped output, no raw HTML, safe URL
  schemes only, bounded chart JSON. `redactSessionEvent` (server) is for secrets;
  the canvas escaping is the XSS boundary.
- **Wide-rule C / presentation:** `.measure` (~660px) for prose; `.breakout`
  (~900px) for charts/galleries; presentation widens breakout + hides rail.
- **Isolation:** no fetch/SSE/globals; renders handed-in events + emits copy. Unit-
  tested standalone (incl. malicious-markdown cases).

## 6. Security

- **`--allow-shell` + auth on everything** (`/session/*`, `/api/img`): `403
  shell_disabled` unless enabled; cookie + same-origin/host-port + membership +
  containment; gate-before-side-effect.
- **`:id` containment (R1/MAJOR-9).** `:id` must match a UUID; the transcript path
  is resolved **only** through `session-index.resolveTranscript` (which maps a
  known id → its file inside the agent's own `~/.claude/projects/<enc>` dir) and
  **realpath-checked** to be under that dir. No client-supplied path; an id not in
  the agent's index → 404.
- **Image proxy = the SSRF boundary (R1/BLOCKER-1, MAJOR-8, R2/MAJOR-4).** `https:`
  only; host allowlist; **resolve + reject private/loopback/link-local/ULA/
  IPv4-mapped/CGNAT/numeric-literal**; **pin the vetted IP for the actual
  connection** (no re-resolve → defeats DNS rebinding); **manually follow ≤2
  redirects, re-validating each hop**; raster `content-type` allowlist (**reject
  `image/svg+xml`**) **plus magic-byte verification of the actual payload** (reject
  mislabeled SVG/HTML); re-serve with the **sniffed** type + `X-Content-Type-
  Options: nosniff`; byte (≤5 MB) + timeout caps. On any violation → 4xx + code;
  canvas shows a "🖼 blocked" placeholder.
- **Canvas XSS (R1/MAJOR-7).** Escaped markdown, no raw-HTML passthrough, safe URL
  schemes only, bounded chart JSON; adversarial markdown/`<script>`/`javascript:`/
  `onerror` tests are first-class.
- **Transcript redaction.** All streamed/returned content via `redactSessionEvent`
  (recursive secret-scrub + cap) — defense-in-depth on a localhost origin.
- **Lease scope is honest (R1/BLOCKER-2 + R3/MAJOR-2 + R4).** Only dashboard
  **`/message` turns** hold the single-active lease (one turn each); `/resume` is
  selection-only (no lease); terminal launches are recorded + warned, not
  coordinated (documented; future spec).
- **Coordination state in `~/.agent-mesh/`,** outside every agent/mesh root.

## 6b. Cross-platform compatibility (Windows + macOS, incl. PowerShell)

Every OS-touching unit is platform-aware and injectable for tests:
- **Transcript project-dir encoding** (`session-index.encodeProjectDir`): macOS/
  Linux = replace `/`+`.`→`-`; Windows = Claude Code's `C:\…` scheme; with a
  **scan-the-projects-dir fallback** that matches by decoded canonical root so a
  scheme drift never breaks discovery.
- **Liveness probe** (`session-lease.probePid`): macOS/Linux = `ps -o lstart=`
  (C-locale); **Windows = `Get-Process`/`tasklist`/WMI** for pid + start-time. The
  pure `evaluateLease` is unchanged (it consumes `probe` results); only the probe
  is per-OS.
- **Process-tree kill** (`process.killProcessTree`): POSIX process-group signals;
  **Windows = `taskkill /T /F`**.
- **Terminal launcher** (`shell.js`/`shell-launcher.js`, already cross-platform for
  the native entry point): macOS Terminal/iTerm via `.command`; **Windows = a
  PowerShell launch** (Windows Terminal `wt` → `pwsh`/`powershell`, else `cmd`).
  The generated launch command uses the existing per-shell **literal encoders**
  (POSIX single-quote; a **PowerShell-safe** quoter alongside the cmd.exe one) so
  paths/env/`--resume <id>` are injected as data, never interpolated; CR/LF/NUL
  rejected. The `open-terminal` route reuses this.
- **Paths**: all mesh state under `~/.agent-mesh` via `os.homedir()`; `path.join`
  throughout; transcript reads are byte/line based (newline `\n`, tolerate `\r\n`).

Tests run the pure cores on both platform branches with injected probes/encoders;
the spawn/`ps`/`taskkill` shells are injected (no real process/terminal in unit
tests). A documented manual smoke covers a real Windows PowerShell launch.

## 7. Error handling (failure-as-data)

- `--allow-shell` off → `403 shell_disabled` on all routes.
- Unknown agent / containment / bad `:id` → 404 / 403.
- Garbage transcript line → `raw` block (never throws); file vanishes mid-read →
  `error` event + list refresh; truncation/rotation → mirror re-syncs.
- `/message` with stale `expectedActiveId` → `409 active_changed`; lease held →
  `409 session_busy` (+owner). `/resume` itself never 409s (pure selection).
- Reconnect with a real hole (`lastSeq+1 < bufferStartSeq`) or post-truncation →
  `replay_gap` → client full windowed reload.
- `/api/img` violation → 4xx code → "🖼 blocked (reason)" placeholder, layout intact.
- Oversize transcript → windowed; `turnsApprox` flagged in the list.

## 8. Testing (hermetic)

- **`session-index`:** canned project dir → exact `turns`/`firstPrompt`/times for
  ≤cap files; `turnsApprox` for oversize; cache keyed by size/mtime (no re-scan
  unchanged); provenance (R5): a
  `create(dashboard)` session → `origin: dashboard`; an external session (no
  `create`) → `origin: cli`, and after a `select(dashboard)` then
  `open(terminal)` → still `origin: cli`, `lastManagedBy: terminal`; `active`
  heuristic; `resolveTranscript`
  rejects non-UUID + ids outside the agent's index + path escapes.
- **`session-mirror` (rewritten):** late subscriber replays from buffer; reconnect
  `lastSeq + 1 < bufferStartSeq` → `replay_gap` (boundary `lastSeq ==
  bufferStartSeq - 1` replays, no false gap); **two concurrent subscribers on
  different sessions don't cross** (per-session keying); buffer overflow; partial
  trailing line; truncation/rotation.
- **`img-proxy` (SSRF):** allowlisted raster passes (injected lookup/fetch);
  **reject** non-https, disallowed host, private/loopback, **IPv6 numeric +
  IPv4-mapped**, **DNS-rebinding (lookup returns public then private)**,
  **redirect→private**, >2 redirects, `image/svg+xml`, oversize, timeout — and **no
  fetch/connection on reject**.
- **`session-runner` turn:** `setActiveSession` writes `activeId`+`rev`+`select`
  event (no lease/turn); `runTurn({expectedActiveId})` drives `--resume
  <activeId>` under the lease, → `409 active_changed` on stale id, `409
  session_busy` when held.
- **endpoints:** gated (403 w/o allow-shell); list/transcript(windowed)/stream/
  resume shapes; `/api/img` limits; `sessionLogEnabled`; old routes/capabilities
  removed.
- **`result-canvas` (DOM unit):** each event→block; chart fence (valid + malformed/
  oversize → rejected); **malicious markdown/`<script>`/`javascript:` url/`onerror`
  → inert/escaped**; remote `<img>`→`/api/img`; copy payloads; wide-rule classes;
  presentation toggle.
- **stable cursor + line-atomic (R2/MAJOR-1 + R3/MAJOR-1):** `/transcript` and
  `/stream` deliver **line records `{seq, events}`**; a multi-event line is never
  split/duplicated across a page or reconnect boundary; line windowing stable
  across reloads; `replay_gap` only when `lastSeq+1 < bufferStartSeq` (boundary
  `lastSeq==bufferStartSeq-1` replays, no false gap).
- **open-terminal (R2/MAJOR-2):** `/session/:id/open-terminal` resolves `:id` via
  the index, builds a plan containing `claude --resume <id>`, records
  `{kind:'open',source:'terminal',terminalApp,platform}`, returns the warning,
  adds **no** lease; rejects unknown/non-UUID id.
- **resume = pure selection + race guard (R2/MAJOR-3 + R3/MAJOR-2):** `/resume`
  sets `activeId`+`rev`, no lease, no turn; `/message {expectedActiveId}` drives
  `--resume <activeId>` under the lease and returns `409 active_changed` when the
  selection moved between resume and message.
- **img-proxy magic bytes (R2/MAJOR-4):** a payload labeled `image/png` but
  containing `<svg`/`<html` is **rejected**; valid raster passes; responses carry
  `nosniff` + sniffed type.
- **cross-platform (user req):** `encodeProjectDir` for darwin vs win32 (+ scan
  fallback); `probePid` selects the per-OS prober (injected); `killProcessTree`
  win32 → `taskkill /T /F` (injected spawn); the launcher emits a PowerShell-safe
  command on win32 and rejects CR/LF/NUL in paths/env/id.
- **frontend (light):** hidden when disabled; session-primary rail + expandable
  turns; resizable gutter; resume/copy-id; `replay_gap` → reload.

## 9. Build increments — independent, separately-gated milestones (R1/MAJOR-9)

The spec stays one design doc, but each milestone is an **independently shippable
PR with its own acceptance gate** (not a single big-bang delivery):

1. **M1 · Data + lease.** `session-index` (events.jsonl provenance, incremental
   byte-capped scan, `resolveTranscript`), rewritten `session-mirror`
   (per-session buffer + line-record + `replay_gap`), `session-runner`
   `setActiveSession` + `runTurn({expectedActiveId})`. Tests.
   *Gate: index + mirror correctness, no UI.*
2. **M2 · Image-proxy security.** `img-proxy.js` (full SSRF hardening) + `/api/img`,
   gated. *Gate: the SSRF test matrix is green.*
3. **M3 · Result Canvas unit.** `result-canvas.js` + paper CSS + templates + copy +
   wide-rule C + sanitizer. *Gate: standalone DOM + XSS tests.*
4. **M4 · Session-log UI + endpoints.** `/session/list|:id/transcript|:id/stream|
   :id/resume`, `session-log.js` B view, capability/route migration, replace lean
   panels. *Gate: end-to-end browse + live + resume.*
5. **M5 · Polish.** presentation refinements, chart-fence docs, retire dead lean
   code.

## 10. Non-goals (v1)

- No delete/rename/archive of sessions.
- **No cross-process terminal single-active leasing** (terminal launches —
  macOS/Windows — are recorded + warned, not coordinated) — deferred to a future
  "terminal joins the lease" spec.
- No remote/cross-machine transcripts (local `~/.claude/projects` only).
- No full charting library — bar + line SVG only.
- No loosening of `img-src` — images strictly via the allowlisted raster proxy
  (no remote SVG).
- Resume drives **ask-only**; full-native resume from the dashboard is out of scope.
- Default dashboard (no `--allow-shell`) unchanged.

## Review log

*Non-normative history. Sections 1–10 are the source of truth; entries below may
quote literals from superseded drafts (e.g. the old `kind:'launch'`/`source:'iterm'`)
to record what changed — the live contract is exactly `kind ∈ {create,select,open}`
and terminal `source: 'terminal'`.*

- **R0 (draft):** canvas visual locked via visual companion (layout B, light paper,
  per-block copy, SVG charts, wide-rule C); data decisions (hybrid index, all
  in-folder sessions, read+light management, live-with-replay, `--allow-shell`,
  image proxy).
- **R1 (codex; 2 BLOCKER / 8 MAJOR / 2 MINOR — all accepted):**
  - BLOCKER (image SSRF) → §3/§6 `img-proxy`: DNS-resolve + reject private forms,
    **pin vetted IP** (no rebinding), per-hop redirect re-validation, raster-only
    (reject SVG), byte/timeout caps; SSRF test matrix (§8).
  - BLOCKER (lease doesn't cover iTerm) → §2/§6/§10: only dashboard resume is
    lease-guarded; iTerm launches recorded+warned, not coordinated; honest scope.
  - MAJOR (lossy source) → append-only `events.jsonl`; derive `originSource` +
    `lastManagedBy` (§2/§3).
  - MAJOR (replay buffer) → per-session keying + `bufferStartSeq` + `replay_gap`
    full-reload (§2/§3/§7/§8).
  - MAJOR (index accuracy) → one-time byte-capped incremental scan, exact turns ≤
    cap else `turnsApprox`; `active` heuristic defined (§3).
  - MAJOR (unbounded transcript) → windowed/paginated `/transcript` + caps + DOM
    cap + "load earlier" (§2/§4/§5).
  - MAJOR (canvas XSS) → sanitizer contract: escape all, no raw HTML, safe URL
    schemes, bounded chart JSON; adversarial tests (§3/§5/§6/§8).
  - MAJOR (proxy SVG) → reject remote `image/svg+xml`; chart SVG client-owned
    (§3/§6).
  - MAJOR (`:id` containment) → UUID + index-only resolution + realpath under the
    agent's project dir (§3/§6).
  - MAJOR (scope) → 5 independently-gated milestones (§9).
  - MINOR (tests) → SSRF/rebinding/SVG/overflow/partial-line/truncation/id-mismatch
    added (§8).
  - MINOR (naming/routes) → unified `sessionLogEnabled`; old routes/capabilities
    removed; migration documented (§4).
- **R2 (codex; 4 MAJOR / 1 MINOR — all accepted) + user requirement:**
  - MAJOR (cursor drift) → one **transcript line-index** cursor across
    `/transcript`, `/stream`, and the buffer; tailer inits from it (§2/§3/§4/§8).
  - MAJOR (open-in-iTerm had no contract) → `POST /session/:id/open-terminal`:
    index-resolve `:id` → launcher builds `claude --resume <id>`, records
    `source:'iterm'`, warns, **no lease** (§4/§6b/§8).
  - MAJOR (resume underspecified) → `/resume` = **switch active session**
    (`setActiveSession`, records, no turn); next `/message` drives it (§3/§4/§8).
  - MAJOR (img-proxy trusts Content-Type) → **magic-byte** raster verification +
    `nosniff` + sniffed type; mislabeled SVG/HTML rejected (§3/§6/§8).
  - MINOR (R1 MAJOR miscount) → corrected to 8.
  - **User requirement (Windows + macOS, incl. PowerShell)** → new §6b: per-OS
    transcript encoding (+ scan fallback), liveness probe, process-tree kill, and a
    PowerShell-safe terminal launcher; pure cores injected + tested on both
    branches (§2/§3/§6b/§8/§10).
- **R3 (codex; 2 MAJOR / 2 MINOR — all accepted):**
  - MAJOR (multi-event line could split across boundary) → the wire unit is a
    **line record `{seq, events:[…]}`**, atomic per line, on `/transcript`,
    `/stream`, and in the buffer (§2/§3/§4/§8).
  - MAJOR (resume both lease-guarded and no-turn; select→message race) → `/resume`
    is **pure selection** (no lease, returns `{activeId, rev}`); the lease lives
    one turn on `/message {expectedActiveId}`, which `409 active_changed` on a
    stale selection (§2/§3/§4/§7/§8).
  - MINOR (replay_gap off-by-one) → gap only when `lastSeq+1 < bufferStartSeq`
    (§2/§3/§8).
  - MINOR (provenance said `iterm` for all terminals) → source `terminal` +
    `terminalApp`/`platform` metadata (§2/§4/§8/§10).
- **R4 (codex; 3 MAJOR / 2 MINOR — all accepted; all consistency cleanups from the
  R3 contract change + one cursor edge):**
  - MAJOR (§6 lease scope stale) → "only `/message` turns are lease-guarded;
    `/resume` selection-only" (§6).
  - MAJOR (§8/§9 still said `runTurn({resumeId})`/resume-by-id/records-event) →
    updated to `setActiveSession` + `runTurn({expectedActiveId})` + `select` event
    (§8/§9).
  - MAJOR (line-index cursor vs byte-capped scan on oversized files) → cursor uses
    an uncapped cheap **newline scan**; only the list **preview** is byte-capped
    (`turnsApprox`); cursor stays exact for huge files (§2/§3).
  - MINOR (§8 mirror test off-by-one) → `lastSeq+1 < bufferStartSeq` + boundary
    replay case (§8).
  - MINOR (§4 route migration wording) → canonical route set declared explicitly;
    lean routes removed outright (no aliases) (§4).
- **R5 (codex; 1 MAJOR / 1 MINOR — all accepted):**
  - MAJOR (`originSource` = first event was wrong) → event kinds `create`/`select`/
    `open`; **origin = the `create` event's source else `cli`** (`select`/`open`
    never change origin); `lastManagedBy` = most recent; external→select→open stays
    `origin: cli` (§2/§3/§8).
  - MINOR (`stop` canonical but unlisted) → added `POST /session/stop` contract to
    the route list (§4).
- **R6 (codex; 1 MAJOR — accepted):** leftover `kind:'launch'` in `open-terminal`
  (§4) + test (§8) → `{kind:'open',source:'terminal',…}`; `launch` removed from the
  spec (kinds are exactly `create|select|open`).
