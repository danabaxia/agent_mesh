 infer or backfill a passRate.

## Components

- **Behavior-state classifier (pure)** — `(behaviorSummary, threshold) → "pass" | "fail" | "no-data"`. Returns `no-data` when `passRate` is `null`/absent/non-numeric. The core seam; pure and table-testable.
- **Rollup health evaluator (`mesh-improvement` summary logic)** — extended so that a `no-data` in any required tier prevents a healthy/"all green" rollup and yields the warning state instead.
- **Report renderer** — adds the distinct `no-data` warning presentation for the behavior tier and adjusts the top-line summary accordingly.
- **Config** — the set of **required** tiers (which tiers' `no-data` blocks "healthy"), and the `no-data` severity policy (warning vs. hard-fail). Defaults: behavior tier required, `no-data` = warning that blocks "healthy."
- **(Optional) triage/daily-review hook** — surfaces the `no-data` warning in the daily review output so it isn't buried.

## Data flow

1. MIR assembles the run summary; `summary.behavior` may be `{ passRate: <number> }` or `{ passRate: null }`.
2. The behavior-state classifier maps it to `pass` / `fail` / `no-data` (null → `no-data`).
3. The rollup evaluator computes overall health:
   - all required tiers `pass` → **healthy / all green**.
   - any required tier `fail` → **regression** state.
   - any required tier `no-data` → **warning** state; **healthy claim is blocked** (this is the 2026-06-25 case: tests 268/268 + adversarial 35/35 but behavior `no-data` → *not* "all green").
4. The renderer emits the report: the behavior tier shows a distinct `no-data` warning; the summary reflects the non-healthy state.
5. The daily review presents the warning so a missing/broken behavioral tier is visible and actionable.

## Testing

Pure-classifier and rollup tests (hermetic):

- **Null → no-data:** `behavior.passRate === null` classifies as `no-data` (not pass, not fail).
- **Absent field → no-data:** missing/undefined `passRate` also classifies as `no-data`.
- **Real pass/fail unchanged:** a numeric `passRate` above/below threshold classifies as `pass`/`fail` exactly as before (no regression).
- **The exact observed case:** tests 268/268 + adversarial 35/35 + behavior `passRate: null` → rollup is **not** "all green"; renders the `no-data` warning.
- **Healthy requires all measured:** rollup reads healthy **only** when all required tiers produced a real passing measurement.
- **no-data ≠ fail:** the `no-data` state renders distinctly from a measured behavioral regression (different message/severity), not collapsed into "red."
- **Rendering:** the report output contains the explicit behavioral no-data warning string and the summary reflects the non-healthy state.
- **Config:** marking the behavior tier non-required allows healthy despite its `no-data`; the `no-data` severity policy (warning vs. hard-fail) is honored.
- **Delta handling:** `delta: null` alongside `passRate: null` does not crash or render a spurious numeric delta.

## Out of scope

- **Fixing or restarting the behavioral eval harness** — this surfaces the absence; diagnosing *why* behavior produced no data is separate.
- **Backfilling or inferring a passRate** — `no-data` is reported honestly, never estimated.
- **Changing behavioral pass/fail thresholds or what the behavior tier measures** — only the null/absence handling changes.
- **Applying the no-data convention to unrelated metrics** beyond the tiered pass-rate summaries — though the same classifier could be reused later, this idea targets `behavior.passRate` (and trivially generalizes to other tier passRates if configured).
- **Auto-remediation / alerting beyond the daily report** — paging or issue-filing on persistent `no-data` is a possible follow-on, not included here.
- **Distinguishing *causes* of no-data** (harness crash vs. skipped vs. timed out) — v1 treats all absence as `no-data`; richer cause attribution is later.
- **Path-guard / anti-spoof / write-boundary changes** — none; pure reporting-logic change.
