# Coder — Long-Term Learnings

These are stable, durable lessons that have proven true across multiple incidents and
are unlikely to change without a significant architectural shift.

---

## Windows Spawn Safety

**Never spawn a `.cmd` or `.bat` file directly on Windows — unwrap the npm shim first.**

Modern Node refuses to spawn a `.cmd`/`.bat` without a shell (CVE-2024-27980) → `spawn EINVAL`.
Every `claude`/`git` spawn must go through `src/process.js` `resolveSpawnTarget`, which
follows the npm `.cmd` shim to its real `.exe`/`.js`, for BOTH a bare `claude` (PATH
search) AND a concrete `AGENT_MESH_CLAUDE=...claude.cmd` path.

When adding a new spawn site: use `spawnFile`/`resolveSpawnTarget`, never a raw `spawn('claude', …)`.
Regression coverage: `test/process.test.js` (win32-guarded).

_Provenance: CLAUDE.md Lessons Learned; first encoded 2026-06-14_

---

## Session Management

**Dashboard/session launches must use `claude --resume <id>`, never `--continue`.**

`--continue` is a recency heuristic: another terminal or transcript touch in the same
cwd can make Claude choose a different context, alternating between correct and wrong
sessions on successive clicks. If the UI has a concrete session id, always pass that
UUID as `--resume <id>`. Use `--session-id` only for a reserved canonical id whose
transcript does not exist yet.

Root cause of the 2026-06-09 alternating-context bug.
Regression: `test/shell-endpoint.test.js`, `test/session-routes.test.js`.

_Provenance: CLAUDE.md Lessons Learned; first encoded 2026-06-14_

---

## MCP Tool Visibility

**Never gate tests or prompts on first-turn MCP tool visibility in headless `claude -p`.**

The stream-json init event reports every MCP server as `pending` — even an instant no-op
server — so the first model call MAY begin before `mcp__agentmesh_peerbridge__*` registers.
A worker asked too early truthfully denies having the tools.

Mitigations:
- Phrase worker-facing tasks FUNCTIONALLY (describe the goal, never the internal tool name).
- Eval fixtures must not assert first-turn tool enumeration.
- `src/cli.js` lazy-loads per command to shrink the init window.

The race is claude-CLI sequencing — not fixable framework-side.

_Provenance: CLAUDE.md Lessons Learned; first encoded 2026-06-14_
