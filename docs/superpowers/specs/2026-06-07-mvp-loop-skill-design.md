# `mvp-loop` Skill — Design

> Rounds 1–2 of Codex review (see [review log](2026-06-07-mvp-loop-skill-design.review.md)) added a precedence rule against the heavy-flow skills (Round 1), an eligibility-triage step, narrower triggers and convergence parsing, an explicit MVP-doc lifecycle, git hygiene, a script safety contract, machine-checkable evals (Round 1); then redesigned the round-shape so feedback is never logged before it exists, widened the trigger policy to "explicit named opt-in", added a hard negation guard to the convergence parser, reconciled the handoff to v1 CLI reality, split the helper into three subcommands, fixed slug rejection-then-normalize order, and replaced GNU-only `realpath -m` with a portable shell check (Round 2). All 19 findings accepted, no rebuttals.

## 1. Goal & motivation

The current superpowers chain (`brainstorming` → `codex-spec-review` → `writing-plans` → `subagent-driven-development`) is rigorously correct for security-critical or cross-cutting work, but token-heavy. The recent settings-inheritance work in this repo produced **1,550 lines of design + review log + plan text** before any implementation code landed. For many tasks — UI experiments, new helpers, small features whose right shape is faster to discover by trying than by speculating — that upfront cost is wasted: the heavy flow rabbit-holes into edge cases that 30 minutes of working code would settle.

**Goal:** add a parallel, lighter-weight entry path that:
1. Builds a minimal working slice the user can actually try — **no upfront design spec**.
2. Iterates on real-world feedback in tight rounds.
3. **Only after the prototype is validated**, hands off to the heavy flow (`brainstorming` → `codex-spec-review` → `writing-plans`), which then has working reference code to ground its design instead of speculating.

**Why this lowers tokens end-to-end:** the heavy flow's expensive parts (`codex-spec-review` rounds, `writing-plans` task enumeration) converge faster when the spec is describing a known-good implementation than when it's speculating about behavior. The MVP loop's modest cost is paid back by shorter, more decisive heavy-flow passes.

**Non-goal:** replacing the heavy flow. The heavy flow is correct for security-critical, cross-cutting, or invariant-load-bearing changes. The settings-inheritance work was a correct heavy spend; this skill does not change that.

## 2. Model & key decisions

- **Skill name and location:** `mvp-loop` at `~/.claude/skills/mvp-loop/SKILL.md` — user-level skill, same shape as `codex-spec-review` and `designing-evals`.

- **Precedence vs heavy-flow skills (load-bearing).** `superpowers:brainstorming` has a `<HARD-GATE>` that forbids implementation before a presented design; `superpowers:using-superpowers` mandates invoking any matching skill; `superpowers:test-driven-development` would normally fire for feature work. `mvp-loop` is the **only** skill that suppresses **all** of: `brainstorming`, `codex-spec-review`, `writing-plans`, `test-driven-development`, and `subagent-driven-development`. The suppression holds only between the §3.0 eligibility check passing and the §5 convergence handoff; outside that window the heavy-flow skills win as normal. The SKILL.md preamble states this rule verbatim.

- **Triggers — explicit named opt-in.** The skill description matches any phrase that **explicitly names** `mvp-loop`, in any of: slash-command form (`/mvp-loop ...`), declarative ("use mvp-loop", "start mvp-loop", "run mvp-loop", "mvp-loop this idea"), or question form ("can we use mvp-loop for X?", "should we mvp-loop the search box?"). **Explicitly removed (false-positive risk):** bare `"mvp"`, `"ship a v0"`, `"fast loop"`, `"try first"`, `"quick prototype"` (without `mvp-loop`). Negative trigger evals in §8.1.

- **Working code is the first artifact.** Each round is one commit on the active branch. **No design spec is written until convergence.** The MVP doc is an *operational log*, not a design spec — see §4.1.

- **A tiny MVP doc accompanies the loop.** `docs/superpowers/mvp/YYYY-MM-DD-<slug>-mvp.md`, ≤ 80 lines total. **Distinct from a formal design spec** (the formal spec is what `brainstorming` produces after handoff).

- **No `codex-spec-review`, `writing-plans`, TDD, or subagent-driven-development inside the loop.** Those land in the heavy flow after handoff.

- **Per-round size cap:** ~150 lines of new code. If a round would exceed it, split into two rounds.

- **Convergence handoff:** when the user's reply matches a precise convergence pattern (§3.1), the skill writes the final blocks, commits, asks one confirmation question, then invokes `superpowers:brainstorming` with a single args string embedding the MVP doc path and SHA range as project context.

## 3. The loop

### 3.0 Eligibility triage (before round 1)

Before the first round, the agent MUST inspect the user's request against this **refusal list**. If any item applies, the skill **refuses to start the loop** and emits a one-line escalation: "This topic belongs in the heavy flow. Routing to `superpowers:brainstorming`."

**Refusal triggers (any one):**
- Auth / permissions / cryptography / session management / token handling
- Schema migrations or any data-shape change that breaks existing readers
- Irreversible deletes (data, branches, prod resources)
- Changes to protected-config paths (per the project's path-guard / Boundary-5 list, when one exists)
- Cross-cutting invariants (touch ≥ 3 modules or named project-level invariants)
- External side effects (deploys, paid-API mutations, prod writes)

**When in doubt, refuse.** The cost of one bad MVP loop on a security-critical change is much higher than the cost of one unnecessary heavy-flow run on something that turns out simple.

### 3.1 Per-round protocol (round-shape with deferred feedback)

```
[explicit named opt-in]
  → §3.0 triage pass
  → start commit (doc header only)
  → round 1: build + open-block in doc → commit → present + try-cmd → wait
  → round N: build + close-block(N-1) + open-block(N) → commit → present + try-cmd → wait
  → user reply matches convergence pattern
  → converged commit: close-block(N) + final cumulative-learnings block
  → §5 confirmation question
  → invoke superpowers:brainstorming OR close loop
```

**Each round-commit closes the previous round's MVP-doc entry and opens the current round's.** For round 1, only the open-block is written (no previous round). For the converged commit, only the close-block plus the final cumulative-learnings block. **At most one round is open in the MVP doc between commits;** the next round-or-converge commit closes it before opening or finalizing.

| Phase | What happens | Output |
|---|---|---|
| Start | Run `append-round.sh init` to create the doc with header | 1 commit `mvp(<slug>): start loop — <goal>` (doc only) |
| Build | Implement the smallest end-to-end slice for this round | (no commit yet) |
| Log + commit | Run `append-round.sh round` (closes prev open-block if any; opens this round's) | 1 commit `mvp(<slug>): round N — <one-line>` (code + doc) |
| Present | Short message: what changed, exact try-cmd, what feedback you want | Chat message |
| Wait | User runs the change; replies | User's next message |
| Decide | Read reply: convergence pattern? → §5. Else → next round | (next iteration) |
| Converge | Run `append-round.sh converge` (closes last round + appends final block) | 1 commit `mvp(<slug>): converged after N rounds` |

**Convergence parsing (three outcomes: `converge`, `confirm`, `continue`).** Apply this dispatch to the trimmed user reply:

1. **Negation check first.** If the reply contains any negation token (regex: `\b(no|not|don'?t|doesn'?t|won'?t|nope|nah)\b`, case-insensitive) → **`continue`** (loop proceeds to next round with the reply as feedback). Never confirm or converge on a negated reply.
2. **Exact-match check.** Else if the reply matches one of these three patterns (case-insensitive, with optional trailing `.`/`!`) → **`converge`** (proceed to §5):
   - `^(ship|approve|finalize|lgtm|converged)\.?!?$`
   - `^(yes|ok|sure|let'?s|please)[,.\s]+(ship|approve|finalize|lgtm|converged)\.?!?$`
   - `^(go ahead|do it)[.,!]?$`
3. **Keyword-in-non-matching-position.** Else if the reply contains any of the keywords `ship`/`approve`/`finalize`/`lgtm`/`converged` (whole-word, case-insensitive) → **`confirm`** (run the confirm sub-protocol below).
4. **Otherwise** → **`continue`**.

**Confirm sub-protocol (when outcome is `confirm`):** the agent asks **one** question, verbatim:

> "I see a convergence keyword in your reply but the phrasing is ambiguous. Do you mean **ship now and hand off to the heavy flow**? (y / n)"

Reply parsing for the confirm sub-protocol:
- Matches `^(y|yes|sure|do it|go ahead)\.?!?$` (case-insensitive, no negation tokens in message) → treat the *original* reply as convergence; proceed to §5.
- Anything else (including non-match, `n`, `no`, or negated text) → **`continue`** with the original reply as feedback for the next round. Do not re-ask.

Negative and ambiguous cases enumerated in §8.3.

**Hard rules during the loop:**
- ❌ No `codex-spec-review` / `writing-plans` / TDD / `subagent-driven-development` invocations
- ❌ No more than ~150 lines of new code per round
- ✅ One round = one commit + one round-block transition (close prev + open this), in the same commit
- ✅ Each Present message ends with an explicit "try this: `<cmd>`"

**Per-round re-triage (mandatory).** Before building each round N ≥ 2, the agent re-applies the §3.0 refusal list **to the user's latest feedback**, not just to the original request. If the feedback introduces work that hits any refusal trigger (auth, schema migration, irreversible delete, protected-config write, cross-cutting invariant, external side effect), the agent **exits the loop immediately** with a one-line escalation: "Round N feedback would expand into heavy-flow territory (<trigger>). Routing to `superpowers:brainstorming`." The MVP doc is committed with the close-block for round N-1 and a brief "## Escalated at round N" terminal block — no more rounds, no §5 handoff confirmation, just route to `brainstorming`.

**Soft warning at round 5:** non-blocking note "5 rounds without convergence — consider escalating to the heavy flow. Continue, or hand off now?" The user chooses.

## 4. Artifacts

### 4.1 The MVP doc (operational log)

Path: `docs/superpowers/mvp/YYYY-MM-DD-<slug>-mvp.md`. Hard length cap: 80 lines.

Template (in order, populated by `append-round.sh` subcommands):

```markdown
# <Topic> — MVP Loop

**Goal:** <one sentence the user gave you>
**Branch:** <branch name>
**Started:** <YYYY-MM-DD>
**Start SHA:** <git rev-parse HEAD at loop entry>

## Round 1 — <one-line summary>
- Change: <one sentence>
- Try: `<exact command>`
<-- closed-block lines added when round 2 begins or convergence happens -->
- Feedback: <user's reply, paraphrased ≤ 2 lines>
- Decision: <revise / converge>

## Round 2 — <one-line>
...

## Converged after N rounds
- Final state: <one sentence>
- What we tried that did NOT work: <bulleted, 1–4 items>
- Cumulative learnings for brainstorming: <bulleted, 2–5 items>
```

**Not a design spec.** No architecture, no invariants, no test plans. Those come from `brainstorming` after handoff.

### 4.2 Commit sequence

In chronological order on the loop branch:

1. **Start commit** — `mvp(<slug>): start loop — <goal one-liner>`. Doc-only (header populated, no rounds).
2. **Per-round commits** — `mvp(<slug>): round N — <one-line>`. Contains the code change AND the doc transition (close previous open-block if any, open this round's).
3. **Terminal commit (exactly one of)**:
   - **Converged** — `mvp(<slug>): converged after N rounds`. Doc-only: closes the last round's open-block and appends the final `## Converged after N rounds` block. Triggered by §3.1 `converge` outcome → §5 confirmation flow.
   - **Escalated** — `mvp(<slug>): escalated at round N — <trigger>`. Doc-only: closes the last round's open-block and appends a `## Escalated at round N` block (one line: which §3.0 trigger fired). Triggered by §3.1 per-round re-triage when feedback expands into heavy-flow territory. **No §5 confirmation** — the agent routes to `superpowers:brainstorming` immediately after this commit lands.

A 2-round-then-converge loop yields 4 commits (start + r1 + r2 + converged); a 2-round-then-escalated loop also yields 4 (start + r1 + r2 + escalated).

### 4.3 Git hygiene

- **Clean-tree check on loop entry.** If `git status --porcelain` is non-empty, the skill refuses unless the user explicitly opts in with the phrase `"mvp-loop dirty-ok"`. Default: refuse.
- **Record `start_sha = git rev-parse HEAD`** in the MVP doc header (via `init` subcommand). Used to compute the SHA range for handoff.
- **Per-round staging is explicit.** The agent stages only paths it actually touched this round, plus the MVP doc. It MUST NOT use `git add -A` or `git add .`.
- **SHA range for handoff** is `<start_sha>..<converged_sha>`.

## 5. Convergence & handoff

When a user reply matches the §3.1 convergence pattern, the agent:

1. **Runs `append-round.sh converge`** to close the last open-block and append the final `## Converged after N rounds` block.
2. **Creates the converged commit** (per §4.2).
3. **Asks one confirmation question, verbatim:**
   
   > "MVP loop converged on `<slug>` after N rounds (SHAs `<start_sha>..<converged_sha>`). Hand off to `superpowers:brainstorming` now to produce the formal design spec? (y / n)"

4. **Parses the confirmation reply** with the same negation guard as §3.1:
   - Matches `^(y|yes|sure|do it|go ahead)\.?!?$` (case-insensitive), no negation tokens → **invoke handoff**.
   - Matches `^(n|no|not now|stop|nope)\.?!?$` → **close without handoff**.
   - Anything else → re-ask the question once. A second non-match closes without handoff (treated as "no").

5. **On invoke:** the agent calls `superpowers:brainstorming` via the Skill tool with **one args string** that embeds both the MVP doc path and the SHA range as project context. Example args string:
   
   ```
   Reference an existing converged MVP. Read the operational log at
   docs/superpowers/mvp/<YYYY-MM-DD>-<slug>-mvp.md and the round commits at
   <start_sha>..<converged_sha>. Your job is to write a formal design spec that
   describes this implementation (not derive a new design from scratch). Skip
   "explore project context" since the MVP doc already names what was tried,
   what was rejected, and what the cumulative learnings are.
   ```
   
   `brainstorming` then proceeds normally → `codex-spec-review` → `writing-plans` → `subagent-driven-development`. Because the design describes a known-good implementation, `codex-spec-review` rounds typically converge faster.

**v1 note:** `brainstorming` does not currently accept `--from-mvp` / `--sha-range` as CLI args. The single-args-string convention above is the v1 mechanism. Explicit CLI args for `brainstorming` are a §9 v1.1 follow-up.

## 6. Non-goals (deliberately deferred)

- **Replacing the heavy flow** for security-critical / cross-cutting / invariant-load-bearing work (§3.0 refusal list).
- **Worktree isolation** for the loop. Deferred to a later `--isolated` mode. v1 uses the active branch.
- **Automated test scaffolding** inside the loop. Tests are written in the heavy flow's TDD pass after handoff.
- **Hard round-count cap.** v1 ships only the soft warning at round 5.
- **Auto-promoting to the heavy flow** without confirmation. v1 always asks (§5 step 3) **for normal `converge` convergence**. **Escalation** (per-round triage trip, §3.1) is the explicit exception: the agent routes to `brainstorming` immediately because the user has implicitly opted into the heavy flow by introducing in-scope-for-heavy-flow work mid-loop.
- **Explicit `--from-mvp` / `--sha-range` CLI args on `brainstorming`.** v1 uses the single-args-string convention; explicit args are a v1.1 enhancement.

## 7. Skill file layout

```
~/.claude/skills/mvp-loop/
├── SKILL.md           ← description + precedence rule + per-round protocol + handoff template
├── scripts/
│   └── append-round.sh   ← three subcommands: init, round, converge
└── tests/
    ├── trigger.yaml      ← §8.1 positive/negative trigger evals
    ├── triage.yaml       ← §8.2 eligibility triage evals
    ├── approval.yaml     ← §8.3 convergence-parsing matrix
    ├── lifecycle.sh      ← §8.4 commit-shape assertion
    ├── dirty-tree.sh     ← §8.5 dirty-tree behavior
    ├── confirmation.yaml ← §8.6 handoff confirmation parsing
    └── append-round.test.sh ← §8.7 adversarial helper tests
```

**SKILL.md frontmatter:**

```yaml
---
name: mvp-loop
description: >-
  Build a minimal working slice the user can try, iterate on real feedback in
  ≤150-line-per-round commits, then hand off to brainstorming →
  codex-spec-review → writing-plans → subagent-driven-development for the
  finalized design and TDD implementation. PRECEDENCE: suppresses brainstorming,
  codex-spec-review, writing-plans, test-driven-development, and
  subagent-driven-development ONLY while the loop is active, and ONLY under
  EXPLICIT NAMED opt-in — any phrase referencing the skill name `mvp-loop`
  (slash-command, declarative, or question form). Bare phrases like "mvp",
  "fast loop", "try first", "quick prototype", or "ship a v0" do NOT trigger.
  REFUSES for: auth/permissions/crypto/session, schema migrations, irreversible
  deletes, protected-config writes, cross-cutting invariants, external side
  effects. Saves token cost end-to-end by letting working code answer design
  questions the heavy flow would otherwise speculate about.
---
```

SKILL.md body restates §§2–5 in the form `codex-spec-review/SKILL.md` and `designing-evals/SKILL.md` use — concise prose with code-block templates the agent copies verbatim.

### 7.1 `append-round.sh` — three subcommands, safety contract

```bash
append-round.sh init     <slug> <goal> <branch> <start_sha>
append-round.sh round    <slug> <n> <prev_feedback> <prev_decision> <one_line> <change> <try_cmd>
append-round.sh converge <slug> <n> <feedback> <decision> <final_state> <rejected> <learnings>
append-round.sh escalate <slug> <n> <feedback> <trigger>
```

- For `round` with `n == 1`, `<prev_feedback>` and `<prev_decision>` are empty strings — the helper skips writing a close-block and only opens the new round.
- `<rejected>` and `<learnings>` are newline-separated bullet lists passed as single string args.
- `escalate` writes a close-block for round `<n>` using `<feedback>` (decision is implicitly "escalate") and appends a one-line `## Escalated at round <n>` terminal block naming the `<trigger>` (one of the §3.0 refusal-list labels). It is the terminal commit's content when §3.1 per-round re-triage fires.

**Safety contract (applied to every subcommand that accepts `<slug>`):**

1. **Reject before normalize.** If `<slug>` contains any of `..`, `/`, `\`, or NUL (`\0`) → non-zero exit, no file touched.
2. **Normalize** via `tr -cs '[:alnum:]-' '-' | tr '[:upper:]' '[:lower:]'`.
3. **Trim** leading and trailing hyphens via `sed 's/^-*//; s/-*$//'`.
4. **Reject** if the normalized slug is empty.
5. **Cap** at 60 chars (`cut -c1-60`).
6. **Path containment** (portable, no GNU `realpath -m`): once at script start, ensure the MVP directory exists and canonicalize it: `mkdir -p "$(git rev-parse --show-toplevel)/docs/superpowers/mvp"; mvp_dir_canonical=$(cd "$(git rev-parse --show-toplevel)/docs/superpowers/mvp" && pwd -P)`. Then compute the target's parent: `target_dir=$(cd "$(dirname "$target_path")" 2>/dev/null && pwd -P)`. If `cd` fails OR `"$target_dir/$(basename "$target_path")"` does not start with `"$mvp_dir_canonical/"` → non-zero exit.
7. **All string args written via heredoc to a tmp file then atomic `mv`** to the target. No `eval`, no `echo -e`, no shell-string concatenation of user input.
8. **Returns non-zero exit + clear stderr message** on any failure (slug invalid, path escape, write error). Adversarial inputs covered in §8.7.

## 8. Testing strategy (machine-checkable)

All eval files live at `~/.claude/skills/mvp-loop/tests/`.

### 8.1 Trigger evals (positive + negative)

**Eight positive phrases — MUST fire** (any explicit named reference):

| # | Phrase | Expected |
|---|---|---|
| 1 | `/mvp-loop add a dark-mode toggle` | fire |
| 2 | `Can we use mvp-loop on the login page?` | fire |
| 3 | `Let's start mvp-loop for the search box.` | fire |
| 4 | `run mvp-loop for the dashboard tabs` | fire |
| 5 | `quick prototype this with mvp-loop` | fire |
| 6 | `mvp-loop this idea` | fire |
| 7 | `/mvp-loop` (no topic — agent must ask for one) | fire + clarify |
| 8 | `Should we mvp-loop the empty-state copy?` | fire |

**Eight negative phrases — MUST NOT fire** (brainstorming wins):

| # | Phrase | Expected |
|---|---|---|
| 1 | `What's our MVP for Q3?` | no-fire |
| 2 | `Can we ship a v0 by Friday?` | no-fire |
| 3 | `Want a fast loop on the UX?` | no-fire |
| 4 | `Let me try first before we plan.` | no-fire |
| 5 | `Design the MVP for the chat panel.` | no-fire |
| 6 | `Brainstorm an mvp for billing.` | no-fire |
| 7 | `mvp` | no-fire |
| 8 | `Quick prototype an idea for me.` | no-fire |

### 8.2 Triage evals

**Five unsafe topics — MUST be refused** with the §3.0 escalation:
1. "Use mvp-loop to update the auth-token rotation logic"
2. "mvp-loop a schema migration to add a `user_id` column"
3. "Use mvp-loop to delete the deprecated `legacy/` tree"
4. "mvp-loop this: rewrite the path-guard write boundary"
5. "Use mvp-loop to push a hotfix to prod"

**Three safe topics — MUST proceed to round 1:**
1. "mvp-loop a new dashboard layout preset button"
2. "Use mvp-loop on the agent-card click animation"
3. "mvp-loop a markdown renderer for the feed view"

### 8.3 Convergence-parsing matrix (three outcomes: converge / confirm / continue)

Expected outcomes per §3.1 dispatch order (negation check first):
- **`converge`** — no negation AND reply matches one of the three allowlist patterns.
- **`confirm`** — no negation AND reply contains a convergence keyword in a non-matching position (agent runs the confirm sub-protocol).
- **`continue`** — any negation token present, OR no keyword anywhere (loop proceeds to next round with the reply as feedback).

**Five replies — MUST converge:**

| Reply | Expected |
|---|---|
| `ship` | converge |
| `approve.` | converge |
| `LGTM` | converge |
| `yes, ship` | converge |
| `go ahead` | converge |

**Five replies — MUST confirm** (keyword present, position non-matching, no negation):

| Reply | Expected |
|---|---|
| `yes, but make the button smaller, then ship` | confirm |
| `is this ship?` | confirm |
| `let's ship after one more change` | confirm |
| `ship it!` | confirm |
| `maybe finalize the spacing` | confirm |

**Six replies — MUST continue** (no keyword OR negation present → next round):

| Reply | Expected |
|---|---|
| `yes` | continue (no keyword) |
| `good` | continue (no keyword) |
| `good catch — let's fix the typo` | continue (no keyword) |
| `don't ship yet` | continue (negation guard) |
| `not LGTM` | continue (negation guard) |
| `no, finalize next round` | continue (negation guard) |

### 8.4 Lifecycle commit-shape

After a 2-round-then-converge loop on slug `demo`, the assertion is:

```bash
git log --reverse --oneline "$start_sha..HEAD" | sed -E 's/^[a-f0-9]+ //'
```

(`$start_sha` is the value the `init` subcommand wrote to the MVP doc header; `..HEAD` bounds the assertion to the loop's commits regardless of prior repo history.)

Must equal exactly (one per line, no extra commits):
```
mvp(demo): start loop — <goal>
mvp(demo): round 1 — <one-line>
mvp(demo): round 2 — <one-line>
mvp(demo): converged after 2 rounds
```

The MVP doc must end with exactly one `## Converged after 2 rounds` block, and each `## Round` heading must have closed `Feedback:` and `Decision:` lines.

### 8.5 Dirty-tree behavior

- `git status --porcelain` empty → loop starts.
- Non-empty without opt-in → refusal: "working tree is dirty; reply `mvp-loop dirty-ok` to proceed anyway".
- Non-empty + `"mvp-loop dirty-ok"` → loop starts; `start_sha` still recorded as `git rev-parse HEAD`.

### 8.6 Handoff confirmation parsing

- Reply matches `^(y|yes|sure|do it|go ahead)\.?!?$` (case-insensitive, no negation tokens in message) → invoke `superpowers:brainstorming`.
- Reply matches `^(n|no|not now|stop|nope)\.?!?$` → close loop, no handoff.
- Anything else → re-ask the confirmation question once; second non-match → close loop (assume "no").

### 8.7 `append-round.sh` adversarial

`tests/append-round.test.sh` calls the helper with each of:

| Input | Expected |
|---|---|
| `<slug>` = `"my topic"` (space) | normalized to `my-topic`, file created |
| `<slug>` = `"../etc/passwd"` | non-zero exit, no file created (raw-`..` rejection) |
| `<slug>` = `"foo/bar"` | non-zero exit, no file created (raw-`/` rejection) |
| `<slug>` = `""` | non-zero exit, no file created |
| `<slug>` = `"-foo-"` | normalized to `foo` (leading/trailing dash trim) |
| `<slug>` = string of 80 `a`s | capped to 60 chars |
| `<feedback>` = string with embedded `\n` | preserved as literal newline in markdown, doesn't break the block |
| `<feedback>` = `` "let's try `rm -rf /` for fun" `` | backticks rendered literal, no shell exec |
| `<learnings>` = newline-separated bullets | each bullet appears as a `- ` markdown item |

## 9. Open questions

- **Add explicit `--from-mvp <path>` and `--sha-range <range>` support to `brainstorming`?** v1 uses the single-args-string convention; explicit args would let `brainstorming` skip "explore project context" and save a few hundred tokens per handoff. Tentative answer: yes, as a v1.1 follow-up; not blocking v1.
- **Hard cap at round 10?** v1 ships only the soft warning at round 5. Tentative answer: defer until a runaway is observed in practice.
- **Refusal-by-keyword tripwire as a secondary safety net** in case the §3.0 triage misses a destructive topic? Tentative answer: add a tripwire of regex against `rm -rf`, `DROP TABLE`, etc. in v1.1.
