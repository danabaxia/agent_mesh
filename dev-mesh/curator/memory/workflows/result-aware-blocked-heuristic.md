# Pattern: Result-Aware "Blocked" Health Heuristic

**Provenance:** PR #682 · fix `classifyRunHealth` false-positive · 2026-06-30

## What it solves

A health check that gates on "blocked = denial count ≥ threshold" will
false-positive on read-only / analysis-only workers. A model running under
`--allowedTools "Read,Grep,Glob"` may probe unavailable tools (Bash, Write,
etc.) many times on its way to a correct answer — producing 20+ denials yet
completing the task correctly. Denial count alone is not sufficient evidence of
a blocked run.

## The invariant

**Gate "blocked" on `denials ≥ threshold AND result is absent`, not on denial
count alone.**

```
hasCompletedTask = (array-form denials used)
                    && !is_error
                    && num_turns > 0
                    && result is a non-empty string

if (denials >= THRESHOLD && !hasCompletedTask) → blocked
else                                           → ok (denials are incidental)
```

## When the exception applies (and when it doesn't)

| Denial form | Exception applies? | Why |
|---|---|---|
| `permission_denials[]` (array, per-denial detail) | **Yes** — check `result` | Detail is available; inert denials already filtered out |
| `permission_denials_count` (number, no detail) | **No** | Cannot distinguish incidental from structural — stay strict |

The array form is produced by `claude-code-action` with `show_full_output`.
The count-only form comes from bare `claude -p --output-format json` envelopes
seen in real backlog runs (2026-06-15 Bash(git:*) incident, counts 25–28).

## Inert denial filtering (complementary)

Before applying the threshold, drop denials whose JSON fingerprint matches
`INERT_DENIAL_SIGNATURES` (e.g. `.claude`, `fewer-permission-prompts`). These
touch the runner's ephemeral config and change nothing about whether the agent
did its job. Only the array form carries the detail needed to filter — the
count form is used as-is.

## Latent risk (reviewer note — follow-up test)

A production write-capable worker that fails to push (blocked) can still emit a
non-empty `result` string: "I attempted to push but Bash was denied." In that
case `hasCompletedTask` would be `true` and the `blocked` branch would be
skipped. This exception is safe **only for analysis-only (read-only) workers**
whose deliverable IS the result string. For write-capable workers, add an
additional test: `permission_denials_count + non-empty result → still blocked`.

## Reuse checklist

When writing a health classifier that uses a denial threshold:

- [ ] Check the denial form (`array` vs `count-only`) before applying any exception.
- [ ] If `array`: filter inert denials first, then check `result` presence.
- [ ] If `count-only`: use the raw count with no exception — stay strict.
- [ ] Add test: `denials >= threshold + empty result → blocked` (core case).
- [ ] Add test: `denials >= threshold + non-empty result + array form → ok` (exception).
- [ ] Add test: `permission_denials_count + non-empty result → blocked` (no exception).
- [ ] Document clearly whether the worker is analysis-only or write-capable.
