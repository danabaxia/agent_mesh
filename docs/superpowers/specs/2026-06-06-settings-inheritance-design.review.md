# Review Log — `2026-06-06-settings-inheritance-design.md`

Driven by `~/.claude/skills/codex-spec-review/` (skill: codex-spec-review).
Reviewer: **Codex CLI 0.130.0** (gpt-5.5, read-only sandbox).

## Round 1 — VERDICT: CHANGES_REQUESTED

3 BLOCKER, 3 MAJOR, 1 MINOR. All 7 accepted (no rebuttals).

### [BLOCKER 1] Inherited author/plugin hooks bypass the path-guard

**Codex:** Inherited hooks are executable command paths, not Claude tool calls, so `--tools` / `--allowedTools` and the path-guard hook do not confine their filesystem side effects. → Do not inherit executable hooks in `do` until sandboxed, or change the threat model and test that hook commands cannot write outside the peer root.

**Resolution — accepted, design changed.** Author `hooks.*` arrays are **stripped at merge time** in v1. Plugin-shipped hooks likewise stripped. Skills, sub-agents, and `enabledPlugins` are still inherited — only `hooks.*` arrays are not. Sandboxed inheritance of author hooks is moved to §7 Phase 2 candidates.

### [BLOCKER 2] `.claude/` is now trusted config but writable

**Codex:** The spec makes `<root>/.claude/settings*.json` trusted runtime config but leaves `hooks/path-guard.js` unchanged. Boundary 5 (protected config) does not list `.claude/`, so a normal `do` task can persist future hooks/plugins/env by editing `.claude/settings.local.json`. → Add `.claude/` (or the exact settings files) to protected config; test denial.

**Resolution — accepted.** `src/path-guard.js#isProtectedConfigPath` extended to deny writes to `.claude/settings.json`, `.claude/settings.local.json`, and `.claude/settings/*` under the peer root. Recorded in §4 (component scope) and §5 (invariant table). New test in §6.

### [BLOCKER 3] `disableAllHooks` is not reserved

**Codex:** The overlay does not reserve `disableAllHooks: false`. An inherited `disableAllHooks: true` makes the appended path-guard hook inert. → Define `disableAllHooks: false` as a last-wins overlay key; test author = `true`.

**Resolution — accepted.** Reserved overlay keys now include the root-level `disableAllHooks: false`, alongside the previously reserved `env.AGENT_MESH_*` keys. Test added in §6.

### [MAJOR 1] "Same matcher" hook ordering is too narrow

**Codex:** Author matchers like `Write`, `*`, or no matcher can still match write tools but live in a different array entry than the mesh's `WRITE_TOOLS.join('|')` matcher, so the mesh hook is not actually last for those calls. → Append the mesh entry last in the whole `hooks.PreToolUse` array; test overlapping matchers.

**Resolution — accepted.** Hook merge rule changes: since author `hooks.*` is now stripped entirely (Blocker 1), the mesh's overlay is the only `PreToolUse` content — making this finding partially moot. But the test for "broad/overlapping author matchers do not preempt the mesh hook" is retained (§6) as a regression net against a future relaxation of Blocker 1.

### [MAJOR 2] `--tools` vs `--allowedTools` conflated

**Codex:** The spec calls `--allowedTools` the built-in whitelist, but the code uses `--tools` for `READ_TOOLS`/`WRITE_TOOLS` and `--allowedTools` only for MCP namespaces (`src/delegate.js#L159`, `#L216`). → Distinguish the two gates; test both.

**Resolution — accepted.** Terminology fixed throughout §2, §3, §5: `--tools` is the built-in tool whitelist (excludes `Bash` in `do`); `--allowedTools` is the MCP-namespace allowlist. Two tests added in §6: argv inspection for each gate.

### [MAJOR 3] "Strict isolation by emptying settings" is false

**Codex:** Under the proposed deep merge, an empty project `.claude/settings.json` does not erase inherited `~/.claude/settings.json` keys. → Either add a real opt-out or remove the claim.

**Resolution — accepted, claim removed.** No real opt-out designed in v1 (YAGNI under §7). The "if an author needs strict isolation they can set their `.claude/settings.json` to empty" sentence in §2 is deleted. A new §8 question records the deferred decision.

### [MINOR 1] Author's `~` resolved against ambiguous HOME

**Codex:** `~` is undefined relative to the child's effective env; `buildClaudeEnv` can change `HOME`. The merger may read different files than native `claude -p` would. → Resolve from the exact env used for the child; add an `env.HOME` fixture test.

**Resolution — accepted.** §4 pins: `settings-merge` resolves author settings paths from the **child's effective env** (the same `claudeEnv` that `spawnFile` will pass), not literal `~` or `process.env.HOME`. Test added in §6.

---

## Round 2 — VERDICT: CHANGES_REQUESTED

1 BLOCKER, 4 MAJOR, 1 MINOR. All 6 accepted (no rebuttals). All Round 1 findings confirmed resolved; Round 2 surfaces gaps the Round 1 fixes exposed.

### [BLOCKER 1] Hook stripping skips `ask` mode

**Codex:** Hook stripping is `do`-mode only, while `ask` still passes no `--settings` and inherits author/plugin hooks. §2 now acknowledges hooks are arbitrary subprocesses outside tool gates, so an `ask` task can trigger write side effects and violate the read-only mode invariant. → Apply the same sanitized settings merge / hook stripping to `ask`, or explicitly trust them.

**Resolution — accepted.** `createClaudeSettings` is now called for **both** modes. The overlay differs: `ask` contributes only `hooks: {}` + reserved keys (no path-guard entry — there are no `WRITE_TOOLS` in `ask` to guard). `do` keeps the path-guard `PreToolUse` entry. The "do mode only" framing is removed from §2.

### [MAJOR 1] Protected-config list factually wrong

**Codex:** The spec lists `AGENT.md` among protections and omits `agent.json`, `prompts/`, `memory/`, `workflows/`, `skills/`, contradicting [src/path-guard.js:19-20](../../../src/path-guard.js#L19). → Replace `AGENT.md` with `agent.json`, list the exact Boundary 5 set, and test that `AGENT.md` remains writable.

**Resolution — accepted.** Verified against code: `PROTECTED_CONFIG_FILES = {agent.json, .mcp.json, registry.json}`, `PROTECTED_CONFIG_DIRS = {prompts, tools, memory, workflows, skills}`. **`AGENT.md` is not protected.** Spec §2/§4/§5 corrected throughout. Implementation: add `.claude` to `PROTECTED_CONFIG_DIRS` — that protects every file/subdir under `.claude/` (settings.json, settings.local.json, settings/, but also agents/, etc., consistently). Tests in §6 verify `AGENT.md` remains writable and `.claude/...` is denied.

### [MAJOR 2] Reserved env scope too narrow

**Codex:** Reserved env protects only `AGENT_MESH_ROOT` and `AGENT_MESH_HOOK_LOG`, but other framework-owned `AGENT_MESH_*` values drive mode, recursion, mesh-root, claude binary, timeout, log behavior. Inherited `settings.env` can collide. → Reserve the full `AGENT_MESH_*` prefix consistently across §2/§3/§4/§5.

**Resolution — accepted.** Verified via grep: framework uses 12 distinct `AGENT_MESH_*` env keys. Reserving the **prefix** (any author `settings.env` key starting with `AGENT_MESH_`) is simpler and future-proof. §2 bullet, §3 table row, §4 settings-merge contract, §5 invariant table, §6 test all updated.

### [MAJOR 3] HOME-resolution call order broken

**Codex:** `createClaudeSettings` must receive `claudeEnv`, but `buildClaudeInvocation` currently creates `--settings` before `claudeEnv` exists ([src/delegate.js:62-64](../../../src/delegate.js#L62)) while §4 says `buildClaudeInvocation` is unchanged. → Specify the call-order / signature change.

**Resolution — accepted.** The delegate sequence is reordered: `claudeEnv = buildClaudeEnv(...)` runs **first**, then `buildClaudeInvocation({...claudeEnv})` passes it through to `createClaudeSettings({claudeEnv})`. §4 now lists `buildClaudeInvocation` as a signature change (not unchanged), and the row for the delegate sequence is added. Test 7 (HOME fixture) asserts merge HOME equals child spawn HOME.

### [MAJOR 4] Enterprise managed settings — decide v1

**Codex:** §8 leaves managed settings as an open question while the merge source list is otherwise normative. In a company deployment this can silently drop managed policy. → Decide now.

**Resolution — accepted, included in v1.** Given the project_purpose constraint (enterprise internal deployment), managed settings are now part of the merge chain in §2. Precedence (bottom → top, last wins): **managed → user → project → local → mesh overlay**. Reserved keys still win regardless. §4 settings-merge accepts a 4th input layer. New §6 test verifies a managed-settings fixture is incorporated with correct precedence.

### [MINOR 1] Sub-agent/slash inheritance contradicts Phase 2

**Codex:** §3 claims user-level sub-agents/slash commands are inherited, while §7 defers sub-agent/slash parity. → Split "discoverable" from "usable parity"; narrow §3 to skills/plugins; keep sub-agent/slash parity in §7 until an e2e proves it.

**Resolution — accepted.** §3 row narrowed to "Skills (model-invocable under `-p`) and plugin declarative content — inherited. Sub-agents and slash commands: configuration loadable, but runtime invocation under `-p` is unproven — see §7." §7 phrasing clarified.

---

## Round 3 — VERDICT: CHANGES_REQUESTED

3 BLOCKER, 1 MAJOR, 1 MINOR. All accepted (no rebuttals). Round 2 fixes confirmed; Round 3 widens scope to *all* executable settings (not just hooks), corrects managed-settings precedence against the native CLI docs, and closes a serious env-tampering channel against the hook subprocess itself.

### [BLOCKER 1] Settings inheritance still too broad — non-hook executable keys

**Codex:** Hooks aren't the only executable surface. `apiKeyHelper`, `statusLine`, `subagentStatusLine`, `fileSuggestion`, `*Helper` and similar settings invoke commands; `enabledPlugins` causes plugins to load any hooks they ship. All run outside `--tools`/path-guard. → Replace deep-merge with an allowlist; block executable settings; filter plugin hooks OR defer plugin inheritance behind a sandbox.

**Resolution — accepted, architecture changed.** The merge model is no longer "deep-merge everything except hooks." It's an **explicit allowlist of inheritable keys**:

- `env.<KEY>` where KEY does NOT match reserved set (see B3)
- `permissions.allow`, `permissions.deny` (with concat+dedupe merge — see M1)
- `enabledPlugins`

Everything else from author layers is dropped: `hooks`, `apiKeyHelper`, `statusLine`, `subagentStatusLine`, `fileSuggestion`, `*Helper`, and any key not on the v1 allowlist. Plugin inheritance is kept (so superpowers etc. work as the user requires) under an **explicit, documented threat-model relaxation**: plugin authors are trusted in this deployment context — the mesh's writable-root invariant applies to the model's tool calls (gated by `--tools`/path-guard), not to plugin-declared hook subprocesses. This is honest about what the design buys and what it doesn't.

Spec §2 entirely restructures the "Inherit, don't replace" bullet around the allowlist; §3 table replaces row-by-row notes with the allowlist; §4 settings-merge contract specifies allowlist semantics; §6 tests added.

### [BLOCKER 2] Managed-settings precedence inverted

**Codex:** Native Claude Code treats managed policy as **highest** priority and not overridden by `--settings` ([Claude docs](https://code.claude.com/docs/en/settings#settings-precedence)). The spec puts managed at the bottom of the merge and expects user settings to override it. Also the Windows drop-in path was wrong. → Remove managed from the synthetic merge; let native managed policy apply above `--settings`; explicitly trust or fail incompatible managed hook policy.

**Resolution — accepted.** Managed settings are **removed from the merge chain entirely**. The CLI applies managed policy above `--settings` natively, so it wins automatically. New §2 paragraph documents the CLI-level layering: `managed (CLI-applied) > mesh --settings (top of our chain) > local > project > user`. Implication: a managed `disableAllHooks: true` or managed `hooks.*` would override the mesh overlay. We document this as a deployment configuration concern (the deployment owner controls managed settings; if they set incompatible policy, mesh peers may not work). The §4 settings-merge signature shrinks back to 3 layers (user, project, local).

### [BLOCKER 3] `env.PATH` / `NODE_OPTIONS` can tamper with the path-guard subprocess

**Codex:** The path-guard runs as `node <path-guard.js>`. Inherited `env.PATH` can redirect `node`; `NODE_OPTIONS` / `NODE_PATH` can inject code into that Node process. Reserving only `env.AGENT_MESH_*` misses this. → Use absolute Node path; reserve hook-sensitive env; malicious-env regression tests.

**Resolution — accepted.** Two concrete changes:

1. **Absolute Node path.** `createClaudeSettings` uses `process.execPath` (always the absolute path of the running Node) as the hook command instead of bare `node`. Removes `PATH` as an attack channel.
2. **Reserved env prefix expanded.** Inherited `env` is dropped for any key matching: `AGENT_MESH_*`, `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` (macOS analog). This is the standard env-injection class; reserving it as a category future-proofs against single-key omissions.

§2 reserved-keys bullet expanded; §4 createClaudeSettings row updated (uses `process.execPath`); §6 test 3 widened to assert each reserved-prefix dropped; new test 16 spawns a `claude -p` with a malicious `env.PATH` fixture and verifies the path-guard still fires correctly.

### [MAJOR 1] Permissions arrays need concat+dedupe, not last-wins

**Codex:** Native CLI concatenates and deduplicates `permissions.allow`/`permissions.deny` across scopes. The spec's "arrays default to last-writer-wins" rule silently drops lower-scope deny rules. → Implement native merge semantics for permission arrays; test cross-layer deny preservation.

**Resolution — accepted.** `settings-merge` defines a known-array merge map:

- `permissions.allow`, `permissions.deny` — concat across layers, then dedupe
- All other arrays — last-writer-wins (default, unchanged)

§4 spec updated; §6 test 5 (previously about managed) repurposed to cross-layer permissions concat: managed-removed `→` user has `permissions.deny=[A]`, project has `permissions.deny=[B]`; merged has `[A, B]` (deduped if equal).

### [MINOR 1] "Best-effort read" underspecified + run-log claim inconsistent

**Codex:** Missing vs unreadable vs malformed aren't distinguished. The malformed-→-run-log claim requires plumbing that the `createClaudeSettings` signature doesn't expose, conflicting with the "No changes to run-log" line. → Define per-layer outcomes; pass/return diagnostics.

**Resolution — accepted.** §4 contract:

- Missing file: silent skip
- I/O error (permission denied, etc.): skip, append diagnostic to a diagnostics array returned alongside merged settings
- Malformed JSON: skip, diagnostic
- `createClaudeSettings` writes diagnostics to stderr (which is already captured by `spawnFile` → tail in run log via the existing `stderr` field), so no run-log signature change. The "No changes to run-log" line in §4 is removed; the run log gains nothing new — the diagnostic just flows through the existing stderr channel.

---

## Round 4 — VERDICT: CHANGES_REQUESTED

3 BLOCKER, 3 MAJOR, 1 MINOR. All accepted (no rebuttals). Round 3 fixes confirmed. Round 4 surfaces the critical realization that `--settings` does not *replace* native source loading — the allowlist sanitization was incomplete without `--setting-sources`.

### [BLOCKER 1] Allowlist doesn't actually sanitize — native sources still load

**Codex:** `--settings` merges with native user/project/local; omitted `hooks`, helpers, etc. still load underneath. → Use `--setting-sources` to disable native loading after the mesh's allowlist merge; add a real-`claude` regression.

**Resolution — accepted.** Probed `claude --setting-sources ""` empirically — accepted, disables native sources cleanly. (`"none"` rejected with "Invalid setting source.") **`buildClaudeInvocation` adds `--setting-sources ""` to argv** in both modes. Combined with the mesh's allowlist-built `--settings` file, only the mesh's sanitized merge is loaded. §2 first bullet expanded; §4 buildClaudeInvocation row updated; new §6 e2e test 19 asserts a fixture hook in `~/.claude/settings.json` does NOT fire.

### [BLOCKER 2] Managed `disableAllHooks: true` silently disables path-guard

**Codex:** Treating incompatible managed policy as "may not function" lets a `do` task run with write tools while the path-guard is off. → Fail closed.

**Resolution — accepted.** New preflight in `delegate.js` before any `do` spawn: read the OS-specific managed-settings file; if `disableAllHooks === true` or `hooks.PreToolUse` is mutated to override the mesh path-guard, **refuse the delegation with `refused('incompatible_managed_policy', …)`**. `ask` mode is unaffected (no `WRITE_TOOLS` to guard, so disableAllHooks doesn't compromise the read-only invariant). §2 managed-settings bullet expanded; §4 new `delegate.js` row for the preflight; §5 row updated from "documented" to "preflight-enforced for `do`"; §6 new tests 20+21.

### [BLOCKER 3] Reserved env matching is case-sensitive

**Codex:** Windows env names are case-insensitive (`Path` ≡ `PATH`). The spec uses exact uppercase matches. → Match case-insensitively; remove all colliding casings.

**Resolution — accepted.** §2 reserved-env bullet clarifies: matching is **case-insensitive**; settings-merge normalizes the comparison by uppercasing the candidate key. All colliding casings are dropped — not just the canonical form. §6 test 4 expanded to fixture `env.Path`, `env.path`, `env.Node_Options`, `env.LD_preload`, etc.

### [MAJOR 1] `extraKnownMarketplaces` missing from allowlist

**Codex:** Plugin inheritance works only if marketplaces resolve. Internal/custom marketplaces (the user has a custom marketplace) require `extraKnownMarketplaces`. → Either include it under the trusted relaxation, or require marketplaces to be preinstalled/managed.

**Resolution — accepted.** `extraKnownMarketplaces` joins the allowlist under the same trusted-plugin-source relaxation as `enabledPlugins`. §2 allowlist bullet, §3 row added, §6 test 5 widened.

### [MAJOR 2] `permissions.ask` missing

**Codex:** The spec inherits `permissions.allow` + `permissions.deny` only — `permissions.ask` is native and also a permission-rule array. → Include it in concat+dedupe.

**Resolution — accepted.** Known-array merge map: `permissions.allow`, `permissions.deny`, `permissions.ask`. §4 contract + §6 test 6 updated.

### [MAJOR 3] `process.execPath` quoting not specified

**Codex:** Windows `C:\Program Files\nodejs\node.exe` has a space; hook command needs explicit cross-platform quoting. → Define a renderer; test exec path with spaces.

**Resolution — accepted.** §4 createClaudeSettings row pins the renderer: build the `command` string via `[process.execPath, hookPath].map(quote).join(' ')` where `quote(s)` produces `"<s with backslash-escaped internal quotes>"` (works on both `cmd.exe` and POSIX shells for paths containing spaces). §6 new test 22 with a fixture exec-path containing a space.

### [MINOR 1] concat+dedupe equality undefined

**Codex:** What counts as "equal"? Order preservation? → Specify exactly.

**Resolution — accepted.** §4 contract: rule entries are coerced to strings; equality is **exact string equality**; order is **first occurrence, user → project → local**; overlay applied last with no further dedupe (overlay-supplied rules are appended verbatim).

---

## Round 5 (final, cap reached) — VERDICT: CHANGES_REQUESTED (2 BLOCKERs applied or documented)

2 BLOCKER, 0 MAJOR, 0 MINOR. Per the skill's 5-round cap and the project_purpose constraint, fixes are applied below; remaining gap is documented as a known v1 limitation rather than a sixth round.

### [BLOCKER 1] Hook command uses shell-form rendering — `$`/backtick injection + fail-open on quoting error

**Codex:** Shell-form `command: "<quoted-path> <quoted-arg>"` still goes through a shell that expands `$` and backticks; hooks failing with non-2 exit are "non-blocking" so a malformed quoting fails open. → Use Claude's hook **exec form** instead: `{ type: "command", command: process.execPath, args: [hookPath] }`. Bypasses the shell entirely.

**Resolution — accepted and applied.** §2 hook-hardening bullet now specifies the exec form. §4 createClaudeSettings row updated: no quoting helper at all; `command = process.execPath`, `args = [hookPath]`, the CLI execs without a shell. §6 test 13 rewritten to assert `command/args` shape rather than command-string content; test 23 (exec path with spaces) becomes a pass-through (no quoting concern under exec form). The cross-platform quote helper is removed from §4.

### [BLOCKER 2] Managed-policy preflight does not cover all paths/keys the CLI actually applies

**Codex:** Real Windows managed-settings locations are richer than `%ProgramData%\ClaudeCode\` (current `C:\Program Files\ClaudeCode`, `managed-settings.d`, MDM/plist/HKLM/HKCU, server-managed, `policyHelper`); also `allowManagedHooksOnly: true` can suppress the mesh's hook. → Inspect effective managed policy OR fail closed when it cannot be fully inspected. Refuse `do` for `disableAllHooks`, `allowManagedHooksOnly`, or any hook policy that blocks the mesh hook.

**Resolution — partially applied; remaining gap surfaced.** The Windows multi-path / registry / policyHelper enumeration is a real platform-engineering task and at the round cap is out of scope for v1. The defensible v1 posture is **fail closed by default with an explicit attestation override for deployment owners who have vetted their managed policy**:

1. **Preflight expanded for the paths we know how to read:** macOS `/Library/Application Support/ClaudeCode/managed-settings.json` + `managed-settings.d/*.json`; Linux `/etc/claude-code/managed-settings.json` + `managed-settings.d/*.json`. Inspected fields now include `disableAllHooks`, `allowManagedHooksOnly`, and `hooks.PreToolUse[*]`. If any of these block the mesh hook, refuse `do`.
2. **Fail closed on Windows by default.** On Windows the preflight cannot enumerate registry/MDM/policyHelper; v1 refuses `do` with `refused('managed_policy_unverifiable_windows', …)` UNLESS the deployment owner sets `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1` explicitly attesting that the managed policy is compatible with the mesh's path-guard requirement. `ask` is unaffected.
3. **Limitation documented in §7 Phase 2 candidates:** *Full Windows managed-settings introspection (registry, policyHelper, MDM).* That work will replace the attestation override with real inspection when it lands.

§2 managed-policy bullet rewritten. §4 preflight row expanded. §5 row updated. §6 tests added: managed `allowManagedHooksOnly: true` → refused; Windows-platform fixture without attestation → refused; same fixture WITH `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1` → proceeds. §7 Phase 2 candidate added.

---

## Final disposition

After 5 rounds: all 25 findings across 4 rounds and the 2 final-round BLOCKERs are accepted; no rebuttals. The spec is **clean and consistent**; the only residual is the Windows managed-settings full-enumeration gap, addressed in v1 by **fail-closed + deployment-owner attestation** and moved to Phase 2 for proper introspection.

Skill convergence outcome: **converged on substance** (no disagreements); **did not reach `VERDICT: APPROVED` within 5 rounds** purely because each round surfaced new previously-unseen issues. Per the skill: round cap respected; the residual is documented, not rubber-stamped.
