---
name: test-strategy
description: Add or adjust tests so the change is verified hermetically by the suite.
---

# test-strategy

Use this so every change is provable. Tests are `node --test`, zero-dep, hermetic.

- Prefer a **pure unit test** for logic; reserve real-`claude` for opt-in e2e.
- Write the failing test first (it should fail for the right reason), then make it
  pass with the minimal edit.
- Cover the negative/safety case, not just the happy path (e.g. a refusal, a
  denied write, an illegal transition).
- Keep fixtures deterministic; don't gate on first-turn MCP tool visibility.

The workflow runs `run-all-tests.mjs`; the tester reports the result back to you.
