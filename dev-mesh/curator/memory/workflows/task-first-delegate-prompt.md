---
slug: task-first-delegate-prompt
status: active
provenance: "PR #700 (2026-07-01), closing Issue #699"
---

# Pattern: Task-First, Delegate-Second Phrasing in Real-LLM Delegation Prompts

## What it solves

Issue #699: the nightly L1 `demo-e2e` test failed once — `claude -p` completed
successfully (`is_error: false`) but the model never called the peer's
`delegate_task` tool, so `B/lib/strings.js` was never written. There was no
code diff in any relevant path (`test/demo-e2e.test.js`,
`scripts/demo-setup.mjs`, `src/delegate.js`, `src/a2a/peer-bridge.js`) since
2026-06-20, and the same assertion had been green for 10 consecutive nights —
so the likely cause is prompt phrasing, not a regression.

The old outer prompt led with tool mechanics:

> Use the library peer's `delegate_task` tool with mode "do" to add a
> truncateSlug(str, max) helper to its strings library ... Then report which
> files changed.

Leading with "use tool X with mode Y to do Z" invites the model to reason
exhaustively about tool semantics before calling it, or to construct the call
differently — a source of delegation flakiness in real-LLM e2e/eval prompts.

## The fix (PR #700)

Reorder so the task is stated first and the delegation directive comes last,
as its own short sentence:

> Add a truncateSlug(str, max) helper to the library peer's strings library —
> slugify the string then cut at the last "-" at or before max, no trailing
> "-". Delegate this code change to the library peer in do mode. Then report
> which files changed.

Task-first / delegation-second is a more natural instruction structure for
current models and reduces the chance the model gets stuck reasoning about
the tool instead of invoking it.

## When NOT to blanket-apply this

If the test needs the mode **argument value** to be exact, natural language
("in do mode") is one more inference step than a quoted, JSON-like value
(`mode "do"`). PR #700's own reviewer flagged this on the changed test, but
noted `assert.equal(log.mode, 'do')` (test/demo-e2e.test.js:112) would catch
a wrong-mode regression — so the reorder was safe there. A second test in the
same file (lines ~143-149) deliberately kept the old quoted explicit form,
because it needs the mode value exact with no equivalent safety-net
assertion downstream.

**Before switching a real-LLM prompt to task-first phrasing, check whether a
downstream assertion would actually catch a wrong-mode/wrong-tool
regression.** If not, keep the explicit quoted form.

## Reuse checklist

- [ ] Is this an outer/test prompt whose job is to make a real model actually
      *invoke* a specific tool (not just describe how)?
- [ ] State the task in plain language first; put the delegation instruction
      ("Delegate this to `<peer>` in `<mode>` mode.") in its own sentence
      afterward.
- [ ] Confirm a test assertion exists on the exact tool/mode argument
      (e.g. `assert.equal(log.mode, 'do')`) before relying on natural-language
      mode references; if none exists, keep the quoted explicit form instead.
- [ ] Treat this as a probabilistic reliability nudge, not a determinism
      guarantee — a single nightly real-LLM occurrence is not automatically a
      regression (the triage classifier's `out_of_scope` bar is 6+
      consecutive failing nights; see Issue #150/#699).

## Related

See CLAUDE.md "Lessons learned" — "MCP tools race the first model turn":
that lesson is about phrasing the **worker-facing** prompt functionally
(never by internal tool name) to survive the first-turn MCP registration
race. This pattern is about the **outer/caller** prompt's instruction
*order* to reliably trigger the delegation call in the first place — a
different mechanism, same family of real-LLM e2e reliability concerns.

## Provenance

PR #700 (2026-07-01), closing Issue #699. Issue #699 refs #150, #166, #169
(the earlier, unrelated OAuth-token-forwarding fix for the same assertion).
