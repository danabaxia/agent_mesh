# Settings Inheritance for Mesh Peers — Design

> Rounds 1–5 of Codex review (see [review log](2026-06-06-settings-inheritance-design.review.md)) reshaped this spec materially. Notably: hook stripping → **allowlist** (R3); `--setting-sources ""` added to actually disable native loading (R4); managed-policy preflight to fail closed for `do` (R4–R5); reserved-env case-insensitive (R4); plugin marketplaces inheritable (R4); hook command rendered in **exec form** to bypass the shell (R5); Windows managed-settings full enumeration deferred behind a `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE` attestation knob (R5). All 25 findings across the rounds accepted; no rebuttals.

## 1. Goal & motivation

`agents_mesh` will deploy inside the user's internal company AI agent system. The peers it orchestrates are **agents and MCP servers already built and tuned in native Claude Code surfaces** — the `claude` CLI, Claude Code Desktop, and Claude Code IDE plugins (Antigravity, Cursor/Windsurf, etc.). Those agents work well in their native surfaces.

Today, when mesh runs a peer in `do` mode it passes `--settings <our-temp-file>` to `claude -p` ([src/delegate.js:160-161](../../../src/delegate.js#L160)) that overrides only `hooks` + a couple of env vars. In `ask` mode no `--settings` is passed at all. Either way, the peer cannot rely on the author's `enabledPlugins`, custom `env`, or `permissions`:

- `do`: the mesh's `--settings` shadows author keys via the CLI's precedence chain — *but doesn't replace them, only layers on top* (R4-B1 below).
- `ask`: settings *do* load — including author `hooks.*`, which are unconfined shell subprocesses that can violate the read-only invariant.

**Goal:** make a peer behave the way it would natively for a tightly bounded set of inheritable settings (skills, plugin content, env, permissions), in both `ask` and `do`, while every existing security invariant ([CLAUDE.md "Invariants"](../../../CLAUDE.md)) still holds bit-for-bit.

**Non-goal (Phase 2 candidates, deliberately deferred):** prompt-cache reuse across delegations; a port to the Claude Agent SDK; loosening `--strict-mcp-config`; sandboxed inheritance of executable settings (`hooks`, `apiKeyHelper`, `statusLine`, etc.); runtime parity for author-defined sub-agents and slash commands under `-p`; see §7.

## 2. Model & key decisions

- **Allowlist, not deep-merge.** Settings are too varied to safely deep-merge. The mesh reads three author layers — user `~/.claude/settings.json`, project `<root>/.claude/settings.json`, local `<root>/.claude/settings.local.json` — and pulls forward **only an allowlisted set of keys**. v1 allowlist (top-level):
  - **`env.<KEY>`** where KEY does NOT match the reserved set (see *Reserved env* below)
  - **`permissions.allow`**, **`permissions.deny`**, **`permissions.ask`** — concat+dedupe across layers (§4)
  - **`enabledPlugins`**
  - **`extraKnownMarketplaces`** — needed so internal/custom marketplaces resolve (the user's deployment has at least one such marketplace)
  - (everything else dropped: `hooks`, `apiKeyHelper`, `statusLine`, `subagentStatusLine`, `fileSuggestion`, `*Helper`, etc.)
- **Disable native source loading.** `--settings` alone does NOT replace the CLI's native loading of `user`/`project`/`local`; it layers on top. To make the allowlist actually sanitize the runtime config, the mesh **also passes `--setting-sources ""`** to argv in both modes. Empirically verified (`claude --setting-sources ""` accepted; `"none"` rejected). With this flag, only the mesh's merged `--settings` file is loaded.
- **Threat-model relaxation for plugin inheritance, documented.** Plugins loaded via `enabledPlugins` may ship their own hooks/MCP servers/agents. The mesh's writable-root invariant applies to **the model's tool calls** (gated by `--tools`, `--allowedTools`, and the path-guard hook); it does **not** apply to plugin-shipped hook subprocesses. Acceptable in the target deployment context (enterprise internal AI; plugin authors are trusted teammates). Explicit relaxation — see §5.
- **Both modes get `--settings` + `--setting-sources ""`.** Author hooks are excluded by the allowlist; `ask` therefore gains the same hook-stripping protection without special-casing.
- **Mode-specific overlay** (applied after the allowlist merge):
  - `do`: `disableAllHooks: false`, `hooks: { PreToolUse: [<path-guard for WRITE_TOOLS>] }`, `env: { AGENT_MESH_ROOT, AGENT_MESH_HOOK_LOG }`.
  - `ask`: `disableAllHooks: false`, `hooks: {}` (no `WRITE_TOOLS` to guard), `env: { AGENT_MESH_ROOT }`.
- **Hook subprocess hardened — exec form, no shell.** The path-guard's `PreToolUse` hook entry uses the CLI's **exec form**: `{ type: "command", command: process.execPath, args: [hookPath] }`. The CLI execs the binary directly with the given args; no shell, so `$`, backticks, and other shell metacharacters in `process.execPath` or `hookPath` are not interpreted, and there is no quoting concern even for paths containing spaces. This is strictly safer than rendering a shell-form `command` string. Removes `PATH` as an attack channel by using `process.execPath` (absolute) instead of `"node"`.
- **Reserved env keys / prefixes** (dropped from any inherited layer; matched **case-insensitively** — Windows allows `Path` ≡ `PATH`):
  - **`AGENT_MESH_*`** (framework-owned)
  - **`PATH`**
  - **`NODE_OPTIONS`**, **`NODE_PATH`**
  - **`LD_PRELOAD`**, **`LD_LIBRARY_PATH`** (Linux loader injection)
  - **`DYLD_INSERT_LIBRARIES`**, **`DYLD_LIBRARY_PATH`**, **`DYLD_FALLBACK_LIBRARY_PATH`** (macOS analog)
- **Managed-policy preflight for `do` — fail closed.** Native Claude Code applies managed settings as the highest-precedence layer ([Claude Code docs](https://code.claude.com/docs/en/settings#settings-precedence)), above `--settings`. Before any `do` delegation, the mesh inspects the managed-settings sources it knows how to read:
  - **macOS:** `/Library/Application Support/ClaudeCode/managed-settings.json` + `managed-settings.d/*.json`
  - **Linux:** `/etc/claude-code/managed-settings.json` + `managed-settings.d/*.json`
  
  Inspected fields: `disableAllHooks`, **`allowManagedHooksOnly`** (can suppress non-managed hooks including the mesh path-guard), and `hooks.PreToolUse[*]` matchers. If any of these would block or override the mesh path-guard, **`refused('incompatible_managed_policy', …)`**.
  
  **Windows: fail closed by default.** The CLI's Windows managed-settings sources include registry (HKLM/HKCU), MDM, plist, `policyHelper`, and multiple drop-in directories that the mesh cannot fully enumerate in v1. The preflight therefore refuses `do` with `refused('managed_policy_unverifiable_windows', …)` **unless** the deployment owner sets `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1`, explicitly attesting that the managed policy is compatible with the mesh path-guard. Full Windows introspection is a Phase 2 item (§7) that will replace the attestation.
  
  `ask` is unaffected on all platforms (no `WRITE_TOOLS` to guard; the read-only invariant holds via `--tools`).
- **`--strict-mcp-config` stays on.** User-level MCP servers (`~/.claude.json`) remain excluded. Per-folder `.mcp.json` + `x-agentmesh.readOnly` is still the only MCP path for peers.
- **Two tool gates stay strict.** `--tools` and `--allowedTools` unchanged. Inherited `permissions` is settings-level only; CLI flags AND.
- **`.claude/` joins Boundary 5 (protected config).** Today's protected set ([src/path-guard.js:19-20](../../../src/path-guard.js#L19)): files `{agent.json, .mcp.json, registry.json}`, dirs `{prompts, tools, memory, workflows, skills}`. **`AGENT.md` not protected** (data, not config). Add `.claude` to `PROTECTED_CONFIG_DIRS` — denies `do`-mode writes under `.claude/` (settings*.json, agents/, etc.).
- **Delegate sequence reorder.** `buildClaudeEnv` runs **before** `buildClaudeInvocation` so the child env can be threaded into `createClaudeSettings`. Today reversed ([src/delegate.js:62-64](../../../src/delegate.js#L62)).
- **Default-on, no flag.** No `AGENT_MESH_INHERIT_SETTINGS` knob. **No "strict isolation" opt-out in v1** — see §8.

## 3. What gets inherited vs. blocked

| Author-side configuration | Behavior |
|---|---|
| `enabledPlugins` | **Inherited.** Plugin skills, MCP servers, sub-agents, hooks all load. Threat-model relaxation — see §5. |
| `extraKnownMarketplaces` | **Inherited** under the same trusted-plugin-source relaxation. |
| Author/plugin skills | **Inherited and invocable** under `-p`. |
| Author/plugin sub-agents & slash commands | **Loadable**, runtime invocation unproven — §7. |
| `hooks.{PreToolUse,…}` author entries | **Blocked** (not on allowlist). |
| `apiKeyHelper`, `statusLine`, `subagentStatusLine`, `fileSuggestion`, `*Helper` | **Blocked** (not on allowlist). |
| `env.<KEY>` where KEY (case-insensitive) is NOT reserved | **Inherited.** |
| `env.<KEY>` where KEY (case-insensitive) IS reserved | **Blocked.** Includes `AGENT_MESH_*`, `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`. Mixed-case casings (e.g. `Path`) also dropped. |
| `permissions.allow`, `permissions.deny`, `permissions.ask` | **Inherited** with concat+dedupe (exact string equality; first occurrence; user→project→local order; overlay last). |
| `disableAllHooks` | **Forced `false` by overlay** — within the `--settings` chain. Managed policy preflight handles the above-`--settings` case for `do`. |
| Managed (enterprise) settings | **Preflight-checked for `do`** (refuse if incompatible). Not part of the synthetic merge. |
| User-level `~/.claude.json` MCP servers | **Blocked** (`--strict-mcp-config`). |
| Per-folder `.mcp.json` author servers | **Unchanged.** Existing `readReadOnlyToolServers` + grant logic. |
| Any other top-level key | **Dropped.** |

## 4. Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/settings-merge.js` (**new**) | Pure **allowlist + overlay** merge: `(layers: [user, project, local], overlay, mode) → merged`. Per-key semantics: `env` — object deep-merge then drop reserved keys (case-insensitive match by uppercasing the candidate key); `permissions.{allow,deny,ask}` — concat across layers, dedupe by exact string equality preserving first occurrence in user→project→local order, then append overlay's entries verbatim; `enabledPlugins` and `extraKnownMarketplaces` — object deep-merge with later-source-wins per nested key. Anything not on the allowlist → dropped. Overlay applied last. **Implementation note:** the merger returns `merged` only; per-layer diagnostics for `io_error` / `malformed` outcomes are emitted to stderr by `createClaudeSettings` (the I/O caller), keeping `settings-merge.js` pure rather than returning a `{merged, diagnostics}` shape. | pure |
| `src/delegate.js` (`createClaudeSettings`) | **Signature:** `({root, mode, claudeEnv}) → tempPath`. Resolves author paths from `claudeEnv.HOME`. Per-layer outcomes: missing → silent; I/O error → diagnostic; malformed JSON → diagnostic. Builds the mode-specific overlay using the CLI's **exec form** for the path-guard entry: `{ type: "command", command: process.execPath, args: [hookPath] }` — no shell, no quoting helper needed. Calls `settings-merge`. Writes merged to temp; writes diagnostics to stderr (flows through `spawnFile` stderr to existing run-log tail; no run-log signature change). | shell (I/O) |
| `src/delegate.js` (`buildClaudeInvocation`) | **Signature changes:** accepts `claudeEnv`. Argv adds **`--setting-sources ""`** (both modes) — disables native user/project/local source loading so only the merged `--settings` file is in effect. Adds `--settings` (both modes). `--strict-mcp-config`, `--tools`, `--allowedTools`, `--permission-mode acceptEdits` (do) unchanged. | shell |
| `src/delegate.js` (managed-policy preflight) | **New, `do` only.** On macOS/Linux, reads the known managed-settings sources (single file + `managed-settings.d/*.json`). Refuses with `refused('incompatible_managed_policy', message)` if any of `disableAllHooks`, `allowManagedHooksOnly`, or a `hooks.PreToolUse[*]` matcher overlaps the mesh path-guard. **On Windows**, refuses with `refused('managed_policy_unverifiable_windows', message)` unless `process.env.AGENT_MESH_ATTEST_MANAGED_COMPATIBLE === '1'` (deployment-owner attestation). `ask` skips the preflight on all platforms. | shell (I/O) |
| `src/delegate.js` (`delegateTask` top-level) | **Sequence reorder:** `buildClaudeEnv` first → `buildClaudeInvocation({..., claudeEnv})`. | shell |
| `src/path-guard.js` (`PROTECTED_CONFIG_DIRS`) | **One-line addition:** add `.claude`. Files set unchanged. `AGENT.md` remains writable. | pure |
| `hooks/path-guard.js` | Unchanged. | shell |

No changes to: contract validation, change-detect, run-log signature, peer-bridge, context-guard, A2A wire surface.

## 5. Security invariants — what holds, what's new

Per [CLAUDE.md "Invariants — do not break these"](../../../CLAUDE.md):

| Invariant | Preserved? | How |
|---|---|---|
| Anti-spoof (`{mode, task}` is the only model-facing surface) | ✅ unchanged | No new fields in tool args. |
| No `Bash` in `do` | ✅ unchanged | `WRITE_TOOLS` unchanged; `--tools` whitelist unchanged. Inherited plugin skills wanting `Bash` denied by the CLI's tool gate. |
| Single writable root **for model tool calls** | ✅ unchanged | Path-guard is the only `PreToolUse` entry the *mesh* contributes. Native sources excluded by `--setting-sources ""`. |
| Read-only `ask` **for model tool calls** | ✅ **strengthened** | Author `hooks.*` excluded by allowlist; native sources excluded by `--setting-sources ""`. |
| **Plugin-hook threat-model relaxation** | ✅ **explicit, new** | `enabledPlugins` inheritance loads plugin-shipped hooks via the CLI's own plugin mechanism, bypassing the path-guard. **Accepted in target deployment** (enterprise internal AI; plugin authors trusted). Deployments needing strict isolation should not enable plugins they don't author or audit. |
| Hook subprocess integrity | ✅ **new** | Hook entry uses CLI **exec form** (`command + args`); no shell, no quoting concern. `command = process.execPath` (absolute), so `PATH` cannot redirect the binary. `env.PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` reserved case-insensitively. |
| Protected config (Boundary 5) | ✅ **strengthened** | `PROTECTED_CONFIG_DIRS` gains `.claude`. Existing protections unchanged. `AGENT.md` remains writable. |
| `AGENT.md` is untrusted data | ✅ unchanged | |
| Failure is data, not exception | ✅ unchanged | Per-layer best-effort outcomes; merge never throws. Diagnostics flow through stderr to run log. |
| Identity = `realpath` canonical folder | ✅ unchanged | |
| `--strict-mcp-config` excludes user MCPs | ✅ unchanged | |
| Two tool gates (`--tools`, `--allowedTools`) stay strict | ✅ unchanged | |
| `disableAllHooks: false` is non-overridable **within `--settings`** | ✅ **new** | Reserved overlay key. |
| `AGENT_MESH_*` + env-injection prefix is non-overridable | ✅ **new** | Reserved set dropped from inherited `env`, case-insensitive. |
| Managed-policy `do` compatibility | ✅ **preflight-enforced** (macOS/Linux) / **fail-closed + attestation** (Windows) | macOS/Linux: preflight inspects `disableAllHooks`, `allowManagedHooksOnly`, and `hooks.PreToolUse[*]` across the known managed-settings paths; refuses `do` if any blocks the mesh hook. Windows: full enumeration deferred to Phase 2; v1 refuses `do` unless `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1`. |

## 6. Test plan

New file `test/settings-inheritance.test.js`:

1. **Allowlist — `hooks` dropped.** Author `hooks.PreToolUse` any matcher → absent from merged.
2. **Allowlist — executable non-hook settings dropped.** `apiKeyHelper`, `statusLine.command`, `subagentStatusLine.command`, `fileSuggestion.command` → none survive.
3. **Allowlist — `disableAllHooks: false` reserved.** Author `true` → merged `false`.
4. **Allowlist — env reserved set dropped, case-insensitively.** Author sets `env.{AGENT_MESH_ROOT, Path, path, NODE_OPTIONS, Node_Options, LD_PRELOAD, LD_preload, DYLD_INSERT_LIBRARIES, dyld_library_path}` → none survive; only overlay-supplied `env.AGENT_MESH_*` values present.
5. **Allowlist — `enabledPlugins` + `extraKnownMarketplaces` deep-merge.** User: `enabledPlugins:{a:true}`, project: `enabledPlugins:{b:true}`, local: `enabledPlugins:{a:false}`. User: `extraKnownMarketplaces:{m1:…}`, project: `extraKnownMarketplaces:{m2:…}`. Merged: `enabledPlugins:{a:false,b:true}`, `extraKnownMarketplaces:{m1:…, m2:…}`.
6. **Permissions — concat + dedupe across `allow`/`deny`/`ask`.** User `deny:[A]`; project `deny:[B]`; local `deny:[A]` → merged `deny:[A, B]`. Same for `allow` and `ask`.
7. **Non-allowlisted top-level keys dropped.** Made-up key not in merged.
8. **HOME resolution.** Merger given `claudeEnv.HOME=/tmp/fixture-home`; merge reflects fixture, not real `~`.
9. **Per-layer outcomes.** Missing file → silent. Permission-denied → diagnostic. Malformed JSON → diagnostic. Other readable layers still merge.

`test/delegate.test.js` adds:

10. **`do` argv has `--tools` without `Bash`** with inherited plugin shipping `Bash`-using skills.
11. **`do` argv has `--allowedTools` with only granted MCP namespaces.**
12. **Both modes' argv include `--settings` AND `--setting-sources ""`.**
13. **`--settings` `hooks.PreToolUse[]` is in exec form** with `command === process.execPath` (absolute) and `args === [hookPath]`. No shell-form `command` string.
14. **No-author-settings regression.** Both modes, no author files → existing behavior.

`test/path-guard.test.js` adds:

15. **`.claude/settings.json`, `.claude/settings.local.json`, `.claude/agents/foo.md` writes denied.**
16. **`AGENT.md` write allowed** (regression: must NOT be in protected config).

`test/delegate.test.js` adds (managed-policy preflight, with fixture managed file injected via env override):

17. **`do` refused when managed `disableAllHooks: true`.** Result: `refused('incompatible_managed_policy', …)`. No `claude -p` spawned.
18. **`do` refused when managed `hooks.PreToolUse` overlaps `WRITE_TOOLS` matcher.**
18a. **`do` refused when managed `allowManagedHooksOnly: true`.**
18b. **Windows fixture without attestation env → refused `managed_policy_unverifiable_windows`.**
18c. **Windows fixture with `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1` → proceeds.**
19. **`ask` is NOT refused by the same managed policy on any platform** (read-only invariant holds via `--tools`).

`test/demo-e2e.test.js` (`AGENT_MESH_E2E=1`) gains:

20. **Real `claude -p` `do` with inherited plugin.** Fixture user settings enables one plugin shipping a benign skill; verify (a) the skill loads, (b) the agent uses it, (c) cross-folder write denied, (d) `.claude/settings.local.json` write denied.
21. **Author hook does NOT fire under `--setting-sources ""`.** Fixture user settings declare a `PostToolUse` hook that writes a marker file; after a `do` delegation the marker is absent — confirming native sources are disabled.
22. **Malicious env regression.** Fixture user settings: `env.PATH=/tmp/evil:$PATH`. After allowlist drops `PATH`, the hook subprocess still runs via `process.execPath` correctly; cross-folder write denied as expected.
23. **Exec-path with spaces** (Windows-flavored). Fixture symlinks `process.execPath` to a location containing a space; the hook still fires correctly because exec form bypasses shell parsing entirely.

## 7. Phase 2 hooks — what this design leaves open

This spec deliberately does **not** address:

- **Sandboxed inheritance of executable settings** (`hooks.*`, `apiKeyHelper`, `statusLine`, etc.).
- **Sub-agent and slash-command runtime parity under `-p`.**
- **Full Windows managed-settings introspection** (registry HKLM/HKCU, MDM, plist, `policyHelper`, multiple drop-in dirs). Until this lands, Windows deployments must set `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1` to enable `do` mode.
- **Prompt-cache reuse across delegations** (`-p` is one-shot).
- **Streaming progress events.**

Decision gate: empirical Phase 1 results.

## 8. Open questions

- Do we want a per-merge stderr line listing which author settings layers were read and which keys collided with reserved/disallowed? Useful for debugging; low cost on top of the existing diagnostics array. **Tentative answer: yes**, one JSON object per layer.
- Should authors get an explicit strict-isolation opt-out (e.g. `agentMeshStrictIsolation: true` in settings that disables inheritance)? Carries a real cost (another control surface). **Tentative answer: defer until an author asks for it.**

Ask user during review.
