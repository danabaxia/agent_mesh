# Agent-Driven Analyst Daily Review — Design

## 1. Goal & principle

Make the daily Analyst performance-review an **agent-driven, in-mesh** task, replacing the
CI-workflow version (PR #178). The mesh's architecture:

- **Actions are data tools + mechanical executors.** GitHub Actions / daemon builtins do the
  expensive data work and **pre-digest** it into compact artifacts (the Tester's MIR, the
  orchestrator's `gh-activity.json` / `daily-report.json`). A deterministic action also does
  the mechanical issue-filing of an agent-produced plan. No reasoning in actions.
- **Agents are the reasoning layer, collaborating in the mesh.** A daemon-scheduled Analyst
  agent delegates to the Tester for the eval summary, reads the compact digests, researches
  the web, reasons, and emits improvement **ideas as data**.
- **Token discipline:** the agent reads small *digests*, never runs `gh`/downloads
  artifacts/scrolls raw logs in-context. The Tester returns a short eval summary, not raw
  scorecards. The builtin (action) does the `gh` issue-filing — zero agent tokens.

Daily output: ≤2 deduped, cited `idea` issues (human-gated, §5.3) tying a performance signal
→ a researched idea.

## 2. Non-goals

- **No CI reasoning.** Revert PR #178's `dev-mesh-analyst-review.yml` (the reasoning-in-an-
  action anti-pattern). The eval/test/MIR **data** actions stay.
- **No global web access.** WebSearch/WebFetch is a **per-agent opt-in**; only the Analyst
  declares it. Other ask agents stay web-less.
- **No agent GitHub mutation.** The agent emits idea-data; the builtin files issues
  (ask-mode can't mutate GitHub — the MIR finding).
- **No `daily-signals` combined digest (v2).** v1 reuses the existing MIR / `gh-activity` /
  `daily-report` digests + a short Tester summary.
- **No code / PR / merge by the agent.** Proposal-only, human-gated.

## 3. Components

### 3.1 Per-agent web-tools opt-in — **manifest-gated** (`src/config.js`, `src/delegate-invocation.js`)
- `config.js`: `export const WEB_TOOLS = ['WebSearch', 'WebFetch'];`
- **The opt-in lives in the operator-owned manifest, not a self-declared card** (BLOCKER fix):
  set `webTools: true` on the agent's entry in `dev-mesh/mesh.json`. A spoofed/tampered
  third-folder `agent.json` therefore **cannot** expand the network allowlist.
- `delegate-invocation.js` ask allowlist (line ~140): append `WEB_TOOLS` **only when ALL**
  hold: (a) `mode === 'ask'`; (b) `route !== 'digest'` (the digest worker never web-searches —
  see below); (c) `AGENT_MESH_MESH_ROOT` is set and its manifest lists a **`served: true`,
  `ask`-enabled** agent whose **realpath-canonical root === the served `root`**, with
  `webTools: true`. Helper `agentWantsWebTools({ root, manifestRoot, route })` is pure-ish
  (reads the manifest via `readManifest(manifestRoot)`, canonicalizes, returns `false` on any
  mismatch / missing root / `route:'digest'`). **Manifest-root derivation (MAJOR fix):**
  `AGENT_MESH_MESH_ROOT` is `<meshRoot>/mesh`, but `readManifest` expects `<meshRoot>`; derive
  `manifestRoot = AGENT_MESH_MESH_CEILING || dirname(AGENT_MESH_MESH_ROOT)` (no walk-up
  fallback). No standalone (non-mesh) run gets web tools.
- **Digest path (BLOCKER fix):** `runDigest()` also calls `delegateTask` and hits this same
  ask allowlist with `route:'digest'`; the `route !== 'digest'` guard suppresses web tools
  there. A digest regression test asserts no web tools on the digest route even for a
  webTools agent.
- **Security:** the grant is operator-owned (manifest, marker-validated), canonical-root
  matched, ask-only, non-digest, read-only egress; fetched pages remain untrusted data. No
  change to the `{mode,task}` surface, write tools, or the path-guard.

### 3.2 `src/dev-society/analyst-ideas.js` (pure planner — mirrors MIR `issues.js`)
- `parseIdeas(agentOutput) → [{ title, body, dedupeKey, labels }]`: extract the agent's
  fenced ```json block of idea objects from its run output; validate each (non-empty title,
  `dedupeKey` matches `/^[a-z0-9:_-]+$/`); malformed/absent → `[]` (never throws).
- `planIdeaIssues(ideas, openMarkers, { scanLabel }) → [{ action:'create', title, body,
  labels, marker }]`: marker `<!-- analyst-idea:<dedupeKey> -->`; **dedup by marker** against
  `openMarkers` (a `Set` of marker strings); cap at 2; labels `['idea', scanLabel]` (scanLabel
  default `generated:analyst`). Pure, validated, injection-safe ids.
- **`openMarkers` are extracted host-side, deterministically** (MAJOR fix): the builtin runs
  `gh issue list --label generated:analyst --state open --limit 500 --json number,body` (the
  explicit `--limit` overrides `gh`'s 30-default so older open markers aren't missed — round-2
  MAJOR fix) and regex-extracts
  `<!-- analyst-idea:(...) -->` from each body — **a deterministic host parse, no model reads
  the bodies** (the MIR invariant is that the *LLM* never reasons over untrusted issue bodies;
  a host regex does not violate it). A pure `extractMarkers(issues) → Set<string>` helper makes
  it testable.

### 3.3 `runAnalystDailyReview(...)` seam + daemon builtin (`scripts/...` + `scripts/dev-society-daemon.mjs`)
The orchestrating **action**, factored into a testable seam (MINOR fix — the daemon doesn't
individually invoke builtins): `scripts/analyst-review-run.mjs` exports
`runAnalystDailyReview({ repoRoot, dryRun, delegate, gh, now }) → { status, output }` with
injected `delegate`/`gh` (defaults: real `delegateTask` + the daemon's `sh('gh',…)`). Steps:
1. `delegate({ root: analystRoot, env: <mesh env, mirror createDelegateRunJob: AGENT_MESH_MESH_ROOT,
   MESH_CEILING, ENABLED_MODES='ask'>, input:{ mode:'ask', task:<prompt> },
   route:'scheduled:analyst-daily-review' })` — the Analyst run (web opt-in via manifest;
   Tester peer reachable via the injected bridge) returns structured idea-data in its summary.
2. `ideas = parseIdeas(result.summary)`; `openMarkers = extractMarkers(gh issue list --label
   generated:analyst --state open --limit 500 --json number,body)`; `plan = planIdeaIssues(ideas, openMarkers)`.
3. If `dryRun`: print the plan, **no `gh` mutation**. Else file each `create` via `gh issue
   create`. Return `{status, output}`. The daemon `builtins['analyst-daily-review']` calls this
   with the real deps; a hidden CLI/env path runs it with `--dry-run` for tests.

The **prompt** (inline, concise; references `research-landscape`) tells the Analyst to:
(a) `delegate_to_peer("tester", "Give a SHORT (≤10 line) summary of today's eval/test
results — regressions only, reading ONLY the MIR digest", new_conversation:true)` — **fresh
session each run** so context doesn't grow/contaminate across days (MAJOR fix: `new_conversation`
if the bridge supports it, else stateless-by-instruction). The Tester response returns through
the bridge **into the Analyst's model turn** — the builtin never sees it, so it cannot post-cap
it; the cap is instead **bound at the source** by constraining the Tester's *input* to the
already-compact `mir.json` digest (a bounded input → a bounded summary), reinforced by the
≤10-line instruction. (A hard bridge-level peer-response cap is noted as a v2 hardening.)
(b) Read the
compact `daily-report.json` + `gh-activity.json` digests (NOT raw logs/`gh`); (c) WebSearch/
WebFetch comparable OSS practices for the observed weaknesses (pages = data); (d) emit a
fenced ```json array of ≤2 `{title, body, dedupeKey, labels}` ideas, each linking a signal →
cited idea; (e) issues-only — no code/specs/memory.

### 3.4 Analyst wiring
- `dev-mesh/mesh.json` analyst entry: add **`webTools: true`** (the manifest-owned web grant,
  §3.1) and `peers: ["tester"]` (was `[]`).
- `registry.json` is **machine-absolute generated wiring** that `dev-mesh/.gitignore` excludes
  (portable dev-mesh contract) — it is **NOT committed** (BLOCKER fix). Bridge injection
  instead depends on `doctor` having materialized a **marker-valid `dev-mesh/analyst/
  registry.json`** listing `tester`. The daemon already runs managed-wiring auto-sync; this
  design only requires that the `doctor --apply` (managed-only) pass run **before the scheduler
  starts** in the daemon/deploy startup path, so `readManagedRegistry(analystRoot)` returns
  `tester` (mesh.json `peers` alone is NOT sufficient — MAJOR fix). Tests assert this by running
  `doctor` on a temp `dev-mesh` copy, then checking `readManagedRegistry` includes `tester`.
- `dev-mesh/analyst/.agent/schedule.json` (new): one job
  `{ id:'analyst-daily-review', kind:'builtin', builtin:'analyst-daily-review',
  cadence:{kind:'daily', at:'09:30'}, enabled:true, saveArtifact:true }`. Shows in the
  SCHEDULES panel under the **analyst** executor (a real mesh agent job).

### 3.5 Revert PR #178 (all 7 files it touched)
Remove `.github/workflows/dev-mesh-analyst-review.yml`,
`test/dev-mesh-analyst-review-workflow.test.js`, **and the obsolete CI spec
`docs/superpowers/specs/2026-06-20-analyst-daily-review-design.md`** (superseded by this
design — MAJOR fix); restore `src/dev-society/gh-activity.js` (drop `ROLE['analyst-review']`),
`test/gh-activity.test.js` (drop its assertion), `test/dev-mesh-assert-run-healthy.test.js`
(count 12→11), `test/dev-mesh-workflow.test.js` (drop `analyst-review` from NAMES).

## 4. Data / control flow

```
daily tick → builtin analyst-daily-review:
  delegateTask(analyst, ask, prompt)
    └─ Analyst (webTools on): delegate_to_peer(tester,"eval summary") ─► Tester reads MIR digest → SHORT summary
       Read daily-report.json + gh-activity.json (digests)
       WebSearch/WebFetch (research) → reason
       → emit ```json [{title,body,dedupeKey,labels} … ≤2]
  parseIdeas(summary) → planIdeaIssues(ideas, openMarkers) → gh issue create (deduped, `idea`)   [mechanical]
```

## 5. Testing

**Hermetic (no claude/gh/network):**

| Test | Covers |
|------|--------|
| `test/analyst-ideas.test.js` | `parseIdeas`: extracts the json block; malformed/absent → `[]`; `dedupeKey` regex-validated. `extractMarkers`: regex-pulls `<!-- analyst-idea:KEY -->` from issue bodies → Set. `planIdeaIssues`: marker dedup vs openMarkers; cap 2; labels `idea`+`generated:analyst`; never throws. |
| `test/web-tools-optin.test.js` | `agentWantsWebTools` is **manifest-gated**: true only when meshRoot's manifest has a `served:true`, ask-enabled agent whose canonical root matches AND `webTools:true`; **false** for a non-served/ spoofed root, missing meshRoot, or `route:'digest'`. Assert the ask allowlist **includes** `WebSearch`/`WebFetch` for the granted analyst run and **excludes** them for (a) a non-opted agent, (b) the `do` path, (c) the **digest route** (regression for the digest BLOCKER). |
| `test/analyst-daily-review-builtin.test.js` | `runAnalystDailyReview({dryRun:true, delegate:fake, gh:fake})` parses a fake agent output → plan, performs **no** `gh` mutation; live path issues create calls; daemon registers `analyst-daily-review`. |
| `test/analyst-agent-schedule.test.js` | `dev-mesh/analyst/.agent/schedule.json` valid (cadence validates); `mesh.json` analyst has `webTools:true` + `peers` includes `tester`; **`readManagedRegistry(dev-mesh/analyst)` returns `tester`** (proves the bridge will inject — MAJOR fix), not just a mesh.json check. |
| revert checks | `dev-mesh-analyst-review.yml` + its lint test + the obsolete CI spec doc gone; gated-workflow count back to 11; NAMES has no `analyst-review`; `ROLE` has no `analyst-review`. |

Full suite green after the revert + additions.

## 6. Config

- `MESH_ANALYST_SCAN_LABEL` (`generated:analyst`) — label for filed ideas. Reuses
  `DEV_SOCIETY_REPO` + the daemon's `gh` auth. `WEB_TOOLS` default in `src/config.js`.

## 7. Invariants preserved

- **Agent reasons, action executes** — the model never mutates GitHub; the builtin files
  issues from the agent's idea-data (deduped, capped, human-gated).
- **Web is scoped + read-only** — only opt-in agents get `WebSearch`/`WebFetch`; fetched
  pages are untrusted data; the `{mode,task}` model-facing surface, write tools, and the
  path-guard are unchanged.
- **Token discipline** — agent reads digests + a short Tester summary; actions pre-digest and
  do the `gh` work.
- **Backlog hygiene** — dedup by marker, ≤2 ideas/run, `idea`-labeled + human-gated.

## Review log

### Round 1 — Codex (gpt-5.5, review account), VERDICT: CHANGES_REQUESTED → all 7 findings accepted

- **[BLOCKER] §3.1 spoofable web opt-in** — moved the grant to the operator-owned manifest
  (`mesh.json` `webTools:true`), gated on a `served:true`/ask agent with canonical-root match;
  a tampered third-folder card can't enable web tools.
- **[BLOCKER] §3.1 digest path inherits web tools** — `runDigest` hits the same ask allowlist;
  added a `route !== 'digest'` guard + a digest regression test.
- **[MAJOR] §3.2 dedup needs bodies, not metadata** — markers extracted **host-side**
  (`gh issue list --json number,body` + regex, no model reads bodies) via `extractMarkers`.
- **[MAJOR] §3.3 tester session resume** — Tester delegation uses `new_conversation:true`
  (fresh daily) + capped returned text.
- **[MAJOR] §3.4 mesh.json ≠ bridge injection** — require a doctor-generated marker-valid
  `analyst/registry.json` with `tester`; test asserts `readManagedRegistry` returns `tester`.
- **[MAJOR] §3.5 revert incomplete** — also delete the obsolete CI spec doc #178 added.
- **[MINOR] §5 builtin not invokable for dry-run** — factored a testable
  `runAnalystDailyReview({dryRun,delegate,gh})` seam.

### Round 2 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 4 findings accepted

- **[BLOCKER] §3.4 registry.json is gitignored** — "commit the generated registry.json"
  contradicts the portable dev-mesh contract. Fixed: keep it generated, rely on the daemon's
  managed-wiring `doctor --apply` running before scheduler start; test runs doctor on a temp
  copy and asserts `readManagedRegistry` returns `tester`.
- **[MAJOR] §3.1 manifest root** — `AGENT_MESH_MESH_ROOT` is `<meshRoot>/mesh` but
  `readManifest` expects `<meshRoot>`. Fixed: derive `manifestRoot = AGENT_MESH_MESH_CEILING ||
  dirname(AGENT_MESH_MESH_ROOT)`, no walk-up fallback.
- **[MAJOR] §3.3 Tester response can't be host-capped** — it returns through the bridge into the
  Analyst's model turn; the builtin only sees the Analyst's final summary. Fixed: bound the cap
  at the source by restricting the Tester's input to the compact `mir.json` digest (+ ≤10-line
  instruction); a hard bridge-level cap is a noted v2 hardening.
- **[MAJOR] §3.2/§3.3 dedup misses old markers** — `gh issue list` defaults to 30. Fixed:
  explicit `--limit 500` before `extractMarkers`.
