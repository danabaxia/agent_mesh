rides and task transform to a scenario run without altering its probes/assertions.
- **Per-variant scorecard + cross-variant classifier (pure)** — `(perVariantResults) → { perVariant, aggregate, classification }` where classification ∈ `{ healthy, scaffold-sensitive, genuine-regression }` per the attribution rule. Pure, table-testable.
- **Scorecard renderer** — adds the per-variant column, aggregate, and the `scaffold-sensitive` / genuine-regression tag to the eval output / daily review.
- **(Reused) existing `AGENT_MESH_EVAL_NO_ROSTER` seam** — now one entry in the catalog rather than an ad-hoc toggle.

## Data flow

1. `eval-a2a.mjs` is invoked with `--scaffold-variants baseline,no-roster,terse-task` (or no flag → `baseline` only).
2. For each selected scenario × each requested variant:
   - the variant applier sets `envOverrides` and applies `taskTransform` to the task,
   - the scenario runs with its **unchanged** probes/assertions,
   - pass/fail (and any metrics) are recorded under `(scenario, variant)`.
3. The cross-variant classifier compares each scenario's results across variants:
   - one-variant drop → `scaffold-sensitive`;
   - all-variant drop → `genuine-regression`;
   - stable → healthy.
4. The renderer emits a per-variant column + aggregate + classification.
5. The daily review now shows *attributable* movements: a reviewer can tell a real regression from scaffold noise instead of guessing.

## Testing

Pure-catalog, applier, and classifier tests (hermetic):

- **Default unchanged:** no `--scaffold-variants` flag → only `baseline` runs; output identical to today (regression lock on existing usage).
- **Variant application:** `no-roster` sets `AGENT_MESH_EVAL_NO_ROSTER=1`; `terse-task` reduces the task to its first sentence — verified against fixtures.
- **Probes invariant:** a scenario's assertions/probes are byte-identical across variants (only framing differs).
- **Classifier — scaffold-sensitive:** results passing in `baseline` but failing only in `terse-task` → classified `scaffold-sensitive`, not a genuine regression.
- **Classifier — genuine regression:** a drop across all three variants → classified `genuine-regression`.
- **Classifier — healthy:** stable across all variants → healthy.
- **Catalog purity:** `scaffold-variants.mjs` transforms are pure (same input → same output, no side effects).
- **Scorecard rendering:** per-variant column, aggregate, and classification tag all present and correct for a multi-variant run.
- **Determinism:** repeating the same scenario×variant yields the same result; the only diff between compared runs is the variant.
- **Unknown variant name:** an unrecognized `--scaffold-variants` entry is rejected/ignored with a clear message (not a silent no-op that skews the scorecard).

## Out of scope

- **Auto-remediating scaffold sensitivity** — this *measures and attributes*; deciding how to harden a scaffold-sensitive scenario is separate.
- **Changing scenario probes, pass criteria, or the behavior eval's correctness semantics** — variants perturb framing only.
- **More than the v1 three variants** — additional variants (tool-definition variants, retry-logic variants, prompt-format variants) are a natural follow-on but not in v1.
- **Applying variants to other eval tiers** beyond `eval-a2a.mjs` behavior scenarios (e.g. perf, swebench) — the catalog could be reused later, but this idea targets the behavior eval.
- **Statistical significance / repeated-trial variance modeling** — v1 classifies on single-run-per-variant drops; multi-trial CI/variance handling (cf. MIR variance work) is deferred.
- **Scaffold-version logging / provenance tracking** (à la SWE-agent's scaffold log) — recording which scaffold produced a historical score is a complementary future idea.
- **Making any variant the new default** — `baseline` stays the regression-locked default; promoting a variant is out of scope.
- **Path-guard / anti-spoof / write-boundary changes** — none; pure eval instrumentation.
