 solution is invalid — it would be trivially gameable and would measure nothing.
- **`min_keyword_hits < len(expected_keywords)`** generally, so partial-but-correct answers score, and no single keyword is decisive.
- **Keywords are real, verifiable framework terms** (actual component names, env vars, function/exit semantics) — drawn from the codebase, so a correct answer earns them by understanding, not guessing.

### Phase boundary

- **Phase 1 (this idea):** `ask_only` tasks exclusively.
- **Phase 2 (out of scope):** `do_required` tasks under the architect_editor topology — still gated.

## Components

- **`eval/swebench/tasks/mesh-bench.json` (the only deliverable)** — the populated array of 10–15 descriptors. Pure data.
- **`eval/swebench/harness.mjs` (consumer, unchanged)** — loads descriptors, drives agents, scores by `expected_keywords` / `min_keyword_hits`. The corpus must conform to its existing format.
- **`scripts/eval-swebench.mjs` (runner, unchanged)** — now produces a meaningful scorecard instead of a vacuous one once the corpus is non-empty.
- **Source-of-truth for keywords** — the framework codebase/specs, consulted to ensure keywords are real and answers aren't embedded.

## Data flow

1. Author writes 10–15 descriptors into `mesh-bench.json` following the harness format and coverage/anti-gaming rules.
2. `scripts/eval-swebench.mjs` runs → `harness.mjs` loads the (now non-empty) corpus.
3. For each task, the harness drives the mesh on the `ask_only` question.
4. Each answer is scored: count `expected_keywords` present; pass if hits ≥ `min_keyword_hits`.
5. The harness emits a real L5 scorecard — per-task pass/fail and aggregate — enabling the multi-peer-vs-single-agent comparison the tier exists for.

## Testing

Since the deliverable is data, "testing" validates the corpus is well-formed and discriminating:

- **Schema validity:** every descriptor has all required fields with correct types; `task_type` is `"ask_only"` for all; ids are unique `mb-NNN`.
- **Threshold sanity:** `0 < min_keyword_hits ≤ len(expected_keywords)` for each task; flag any where `min_keyword_hits == len` (brittle) for review.
- **Non-empty load:** `harness.mjs` loads ≥10 tasks (the vacuous-scorecard bug is gone).
- **Anti-gaming review:** for each task, confirm the answer is **not** reconstructable from `task` + `expected_keywords` alone (manual/reviewer check; the core quality gate).
- **Keyword reality:** each keyword corresponds to an actual framework term (component, env var, exit code, function) — verified against the codebase.
- **Coverage:** all five areas (routing, security, board, health, protocol) are represented with ≥2 tasks each.
- **Cross-concern weighting:** a meaningful subset of tasks span two concerns (spot-check that they plausibly benefit from multi-peer splitting).
- **End-to-end smoke:** `scripts/eval-swebench.mjs` runs to a non-vacuous scorecard with the new corpus.

## Out of scope

- **Any production/harness code changes** — `mesh-bench.json` only; `harness.mjs` and `eval-swebench.mjs` are unchanged consumers.
- **`do_required` / do-mode tasks** — Phase 2, under the still-gated architect_editor topology; this is `ask_only` only.
- **Changing the scoring mechanism** (keyword matching, thresholds semantics) — the corpus conforms to the existing scorer; improving the scorer is separate.
- **Automated answer-key grading or LLM-judge scoring** — keyword-hit scoring as the harness already implements; richer grading is a later concern.
- **Expanding beyond 10–15 tasks** or continuous corpus growth — this seeds the tier; ongoing curation is future work.
- **Tasks about systems other than this framework** — the corpus targets the mesh's own surfaces (so keywords are verifiable and answers meaningful).
- **Wiring L5 into the nightly schedule** if not already scheduled — this makes L5 *runnable with content*; scheduling changes (if any) are separate.
- **Anti-spoof / path-guard / write-boundary changes** — none; pure data.
