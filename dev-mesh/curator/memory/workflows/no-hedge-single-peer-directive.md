---
slug: no-hedge-single-peer-directive
status: active
provenance: "PR #750 (2026-07-02), closing Issue #744"
---

# Pattern: Fix a Confusable-Peer Precision Regression with a Persistent No-Hedge Directive — and Lock It With a Test

## What it solves

Issue #744 (mesh-scan): the 6x-confusable perf cell's `precision` metric
regressed -13.3% (1.0 → 0.867) while `recall` stayed at 1.0. `routing()` in
`eval/perf/meters.mjs` computes `precision = hit.length / delegated.length`
and `recall` from whether the correct peer is merely *among* the delegated
set. That means precision and recall diverge on a specific failure mode:
**hedging** — the caller delegates one task to more than one confusable peer
"just in case." Recall survives (the right peer was asked), but precision
falls because the denominator (`delegated.length`) grows. A wrong-peer *miss*
tanks both metrics; hedging tanks only precision. If you see precision drop
with recall intact, suspect hedging before suspecting a routing miss.

## The fix (PR #750)

`buildRoutingMesh` in `eval/perf/harness.mjs` builds the caller peer `A`'s
**persistent** `agentMd` (its system prompt for the whole eval run, not a
per-task instruction). The fix strengthens that persistent prompt with an
explicit single-peer, no-hedge directive:

> Delegate each question to exactly ONE specialist peer — the single closest
> functional match — even when several peers cover related or overlapping
> territory. Never delegate the same question to more than one peer to hedge.

Key point: this belongs in the **persistent** agentMd, not the per-task
prompt (contrast with `[[task-first-delegate-prompt]]`, which fixes a
different mechanism — recall via per-task instruction *ordering*). Hedging is
a standing behavioral bias across every task in the run, so the fix has to be
standing too.

## The gap this PR shipped with (verify before repeating)

PR #750 added the directive string but **no test asserts it landed** in
`agents.A.agentMd`. The one nearby assertion (`test/perf-harness.test.js`,
`assert.match(t.prompt, /delegate this to/i)`) checks the per-task prompt
from `routingTasks`, not the caller's system prompt from `buildRoutingMesh` —
it does not cover this fix at all. A future edit could silently drop the
no-hedge directive and nothing would catch it. Reviewer flagged this on
PR #750; as of merge it was still unaddressed.

## Reuse checklist

- [ ] Precision dropped while recall held ~1.0 in a confusable/overlapping-peer
      eval cell? Check `routing()`'s `precision = hit/delegated.length` first —
      suspect hedging (`delegated.length > 1`), not a wrong-peer miss.
- [ ] Put the fix in the **persistent** obeyed prompt for the caller peer —
      `agents.A.files['prompts/system.md']` in `buildRoutingMesh` — never
      `agentMd`/`AGENT.md` (see Correction below). Hedging is a standing bias
      across every task in the run, so the fix has to be standing too.
- [ ] Add a hermetic assertion on the exact literal by reading the fixture's
      real `prompts/system.md` off disk (e.g. `readFile(join(mesh.agents.A.root,
      'prompts', 'system.md'), 'utf8')` then `assert.match(.../exactly one/i)`
      and a `/never.*more than one/i`-style check) — asserting against an
      `agents.A.agentMd` string proves nothing about what the driven agent's
      real prompt contains.
- [ ] Prefer positive framing ("pick the single closest match; do not also
      delegate to related peers") over a pure negative instruction
      ("never... to hedge") if the directive needs revisiting — negative
      instructions are generally less reliable for LLMs.

## Correction (superseded by PR #765, 2026-07-02)

PR #750's fix (and this doc, as originally written) put the no-hedge directive
in `agents.A.agentMd` — the string `buildRoutingMesh` writes to A's `AGENT.md`.
**That file is never read as A's obeyed system prompt.** `buildAgentRuntimePrompt`
(`src/agent-context.js`) assembles the prompt a driven agent actually behaves
under exclusively from `prompts/system.md` → `memory/*` → `workflows/*` →
`prompts/<mode>.md` → skill summaries → peer roster — `AGENT.md` is not in that
list. `AGENT.md` is only ever consumed as (a) a peer's *self-description* shown
to other callers, or (b) the AgentCard `description` in the A2A handshake
(`src/brains/gemini-agent.js:15`: *"AGENT.md is NEVER read here"*; PROJECT.md
§1.5/§2.3, the AGENT.md-as-data invariant). Agent A here has no callers of its
own describe_self, so the directive text sat in a file the framework
contractually never obeys — inert on every real-`claude` eval run, even though
the hermetic test (which only checks the literal landed in `AGENT.md` on disk)
stayed green throughout.

PR #765 (fixing the compounding `-15%` recall regression on the 12x-confusable
cell, Issue #747) moved the directive to `agents.A.files['prompts/system.md']`
and rewrote the test to read the fixture's real `prompts/system.md` off disk
instead of asserting on the `agentMd` string. **General rule: any eval-harness
fixture that needs to steer a driven agent's own behavior (not its
self-description to others) must inject via `files['prompts/system.md']`
(or `memory`/`workflows`), never `agentMd`/`AGENT.md`.** A test that only
confirms a string landed in `AGENT.md` gives false confidence — it doesn't
prove the string ever reaches the model.

## Related

`[[task-first-delegate-prompt]]` — a different mechanism (recall, via
per-task instruction ordering) in the same family of real-LLM eval-prompt
reliability fixes; don't conflate persistent-prompt fixes with per-task-prompt
fixes when citing either.

## Provenance

PR #750 (2026-07-02): `fix: eval/perf/harness.mjs` — precision-regression fix
for `[mesh-scan] perf-regression: precision regressed (-13.3%)`, closing
Issue #744.

PR #765 (2026-07-02): `[mesh-scan] perf-regression: recall regressed (-15%)`,
closing Issue #747 — corrected the placement bug this doc originally shipped
with (see Correction above).
