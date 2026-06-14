---
name: codex-spec-review
description: >-
  Drive an automated write↔review loop on a design spec with the Codex CLI until
  Claude and Codex converge ("both agree"). THIS IS THE REVIEW GATE IN THE
  SUPERPOWERS FLOW: invoke it right after a design spec has been written (e.g. by
  superpowers:brainstorming) and BEFORE superpowers:writing-plans — whenever a
  spec/design/PRD has just been generated and should be vetted by an independent
  second model before implementation. Also trigger on explicit asks: "codex review
  my design/spec", "have codex check the spec", "co-author/vet a spec with codex",
  "get a second model to review this design", or any cross-model adversarial design
  review. Trigger even when the user doesn't name the loop, as long as a freshly
  written spec needs review. Requires the `codex` CLI, authenticated.
---

# Codex-Reviewed Spec Authoring

You (Claude) write the design spec; the **Codex CLI** reviews it as an
independent second model; you address each finding; you both iterate until you
**converge** — Codex has no remaining actionable findings *and* you have no
further changes. The point is a spec that survived a genuinely independent
adversary, not a spec you reviewed alone.

**Where this sits in the superpowers flow:**

```
superpowers:brainstorming  →  [spec written]  →  THIS SKILL (codex review loop)  →  superpowers:writing-plans
```

It is the **independent-review gate after a spec is generated and before planning**.
The trigger moment is "a design spec was just written." If requirements aren't
settled yet, do `superpowers:brainstorming` first; once Codex and you converge,
hand the finished spec to `superpowers:writing-plans`. It also runs standalone on
any existing spec draft.

Because `superpowers:brainstorming` ends by writing the spec and then heading to
`writing-plans`, the practical handoff is: **right after the spec file is written
(at the brainstorming "review the spec" gate), run this skill before continuing to
`writing-plans`.**

## Before you start

- **Confirm `codex` is available and authenticated:** `codex --version`. If it's
  missing or `codex exec` errors with an auth message, stop and tell the user to
  install / `codex login` — don't silently fall back to reviewing your own work,
  because the whole value here is the *independent* second model.
- **Pick the spec path (convention-aware).** If `docs/superpowers/specs/` exists,
  use `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Else if `docs/specs/`
  or `docs/` exists, use that. Else ask the user where the spec should live.
  Use the real current date.

## The loop

```
draft → codex review → process findings (fix or rebut) → re-review → … → consensus → finalize
```

1. **Draft the spec.** Write a complete first version to the spec path. Cover at
   least: goal, chosen model + the decisions behind it, components/architecture,
   data/control flow, error handling, testing, scope/non-goals. Match the
   project's existing spec style if there is one (read a sibling spec first).

2. **Run a Codex review** (see *Invoking Codex* below). Codex reads the spec from
   the repo and returns findings + a verdict.

3. **Process every finding with judgment — do not rubber-stamp.** Treat Codex
   like a sharp colleague who is sometimes wrong (the
   `superpowers:receiving-code-review` ethos):
   - If the finding is correct → fix the spec.
   - If it's wrong or based on a misread → **don't change the spec; record a
     short rebuttal** with your reasoning. You must carry that rebuttal into the
     next review round so Codex can accept it or push back (consensus needs Codex
     to *drop* the finding, not just you ignoring it).
   - Re-run your own self-review each round too (placeholders, contradictions,
     ambiguity, scope) — you are half of "both agree."

4. **Re-review** the revised spec, **including your rebuttals** as context so
   Codex can react to them. Repeat from step 3.

5. **Converge or escalate.**
   - **Consensus reached** when Codex returns `VERDICT: APPROVED` (no actionable
     findings) *and* you have nothing outstanding (every finding fixed or
     mutually-accepted-as-rebutted). Then finalize.
   - **Round cap:** stop after **5 rounds** even if not converged. Never loop
     forever.
   - **Persistent disagreement:** if you and Codex keep disagreeing on the same
     point, do not just override it — **surface the open disagreement(s) to the
     user** with both positions and let them decide.

6. **Finalize.** Ensure the spec is clean, write the review log (below), and — if
   the user wants it committed — commit the spec + log. Report the round count and
   any unresolved points.

## Invoking Codex

Use the bundled helper, which pins the safe flags (read-only sandbox — a reviewer
must never modify the repo) and handles errors:

```bash
.claude/skills/codex-spec-review/scripts/codex-review.sh "<review prompt>"
# or pipe a long prompt:  echo "<review prompt>" | .claude/skills/codex-spec-review/scripts/codex-review.sh -
```

It runs `codex exec -s read-only` in the repo and prints Codex's response to
stdout. Read that output and act on it.

### The review prompt (output contract)

Give Codex a clear role and a parseable output contract so you can act on it
deterministically. Build the prompt like this each round:

```
You are an independent, skeptical design reviewer. Read the design spec at
<SPEC_PATH> in this repo (and PROJECT.md / sibling specs for context). Review it
for: correctness, internal consistency, hidden assumptions, security/safety,
unscoped ambiguity, and missing test coverage. Be concrete and specific.

[Round N>1 only] In the previous round I addressed your findings as follows, and
pushed back on these with reasoning — re-evaluate them: <REBUTTALS>.

Output EXACTLY:
- One bullet per finding: `[BLOCKER|MAJOR|MINOR] <section/line> — <issue> → <suggested fix>`
- Then a final line: `VERDICT: APPROVED` (no actionable findings) or
  `VERDICT: CHANGES_REQUESTED`.
If the spec is sound, return no findings and `VERDICT: APPROVED`.
```

Parse the `VERDICT:` line for loop control; treat BLOCKER/MAJOR as must-resolve,
MINOR as resolve-or-rebut.

## Review log

Keep a running log next to the spec (e.g. `<spec>.review.md` or a
`### Review log` section appended to the spec) so the process is auditable: per
round, the findings, what you fixed, and what you rebutted (with reasoning). This
is the evidence that "both agreed" — and why.

## Failure modes

- **Codex unavailable / unauthenticated** → stop and tell the user; do not
  substitute self-review.
- **Codex returns malformed output** (no `VERDICT:` line) → re-run once asking it
  to follow the contract; if still malformed, treat its prose as findings and
  continue, noting the format issue.
- **Non-convergence at the round cap** → finalize the best version, list the
  unresolved findings, and ask the user to adjudicate.
- **Codex wants to expand scope** → hold the line on the agreed scope/non-goals;
  rebut scope-creep findings rather than absorbing them.
