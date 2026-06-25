# MIR: Treat Null `behavior.passRate` as a No-Data Alert, Not a Silent Pass

## Goal

When the behavioral eval tier produces no measurement (`behavior.passRate === null`), the MIR must surface an explicit `no-data` signal — a hard finding plus a distinct `status` field — rather than silently equating absence of data with a pass. This mirrors the SRE "no-data = alert" convention (Prometheus `absent()`, Grafana no-data alert state) and how production eval harnesses (promptfoo, OpenAI Evals/Inspect) distinguish an errored/missing run from a passing one.

## Non-goals

- No new eval runner or harness. Only the MIR classification layer (`aggregate.js` / `render.js`) changes.
- No change to the behavior eval itself, L2 runner, scorecard format, or CI wiring.
- No change to perf, adversarial, or test tiers (same pattern for those is a separate issue).
- No auto-retry of a missing eval run.
- No change to `policy.js`, `baseline.js`, `issues.js`, or `collect.js`. The existing filing pipeline handles the new hard finding automatically.

## Background

In `src/mesh-improvement/aggregate.js`, when `collect.js` returns `behavior: null` (absent `scorecard.json`), the existing guard:

```js
if (typeof behavior?.aggregate?.passRate === 'number') { /* soft finding */ }
```

produces zero findings and `summary.behavior.passRate = null`. The rendered table shows `—`, visually indistinguishable from "eval ran and passed." A reviewer reading "all green" has no indication that behavioral health is unknown — a behavioral regression (or broken harness) would be invisible.

## Design

### 1. Hard finding on missing measurement (`aggregate.js`)

```js
if (typeof behavior?.aggregate?.passRate === 'number') {
  findings.push(softFinding({
    id: 'behavior:overall:pass-rate', cluster: 'behavior-regression',
    name: 'passRate', value: behavior.aggregate.passRate,
  }));
} else {
  findings.push(hardFinding({
    id: 'behavior:overall:no-data', cluster: 'behavior-no-data',
    evidence: { trace: 'behavior scorecard absent or passRate missing' },
  }));
}
```

`tier: 'hard'` is correct: no measurement is epistemically equivalent to unknown health. Hard findings are unconditionally fileable through `policy.js` (no changes needed). The id `behavior:overall:no-data` satisfies `^[a-z0-9:_-]+$`.

### 2. Explicit `status` field in `summary.behavior` (`aggregate.js`)

```js
summary.behavior = {
  passRate: behavior?.aggregate?.passRate ?? null,
  status: typeof behavior?.aggregate?.passRate === 'number' ? 'ok' : 'no-data',
  delta: null,
};
```

Additive and backward-compatible. `baseline.js` already handles `subtract(null, prev) → null` correctly.

### 3. Distinct render output (`render.js`)

```js
const bDisplay =
  s.behavior.status === 'no-data'
    ? '⚠ no-data'
    : (s.behavior.passRate != null ? s.behavior.passRate.toFixed(3) : '—');
```

`⚠ no-data` is visually distinct from `—` (true null) and from a numeric pass rate.

### 4. No change to `policy.js`, `baseline.js`, `issues.js`, `collect.js`

The ledger handles `behavior:overall:no-data` like any hard finding. On recovery (measurement returns), cleanRuns increments toward the close threshold automatically.

## Components

- **Behavior-state classifier (pure)** — `(behaviorSummary, threshold) → "pass" | "fail" | "no-data"`. Returns `no-data` when `passRate` is `null`/absent/non-numeric. The core seam; pure and table-testable.
- **Rollup health evaluator (`mesh-improvement` summary logic)** — extended so that a `no-data` in any required tier prevents a healthy/"all green" rollup and raises a hard finding (error severity).
- **Report renderer** — adds the distinct `no-data` presentation for the behavior tier and adjusts the top-line summary accordingly.
- **Config** — the set of **required** tiers (which tiers' `no-data` blocks "healthy"). Default: behavior tier required. Severity is always error (hard finding); no configurable severity policy — Design §1 hardcodes `hardFinding()`.
- **(Optional) triage/daily-review hook** — surfaces the `no-data` warning in the daily review output so it isn't buried.

## Data flow

1. MIR assembles the run summary; `summary.behavior` may be `{ passRate: <number> }` or `{ passRate: null }`.
2. The behavior-state classifier maps it to `pass` / `fail` / `no-data` (null → `no-data`).
3. The rollup evaluator computes overall health:
   - all required tiers `pass` → **healthy / all green**.
   - any required tier `fail` → **regression** state.
   - any required tier `no-data` → **hard finding** (error severity); **healthy claim is blocked** (this is the 2026-06-25 case: tests 268/268 + adversarial 35/35 but behavior `no-data` → *not* "all green").
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
- **Config:** marking the behavior tier non-required allows healthy despite its `no-data`. (Severity is always error/hard as hardcoded in Design §1 — no separate severity-policy parameter to test.)
- **Delta handling:** `delta: null` alongside `passRate: null` does not crash or render a spurious numeric delta.

Note: the existing `empty.findings.length === 0` assertion in `test/mesh-improvement-aggregate.test.js` line 51 must be updated to `=== 1` when this is implemented.

## Risks

| Risk | Mitigation |
|------|------------|
| Existing `empty.findings.length === 0` assertion breaks | Update to `=== 1`; intentional and documented |
| Mesh that never runs L2 evals gets daily no-data issue | Correct signal; ledger dedup ensures one open issue per cluster at a time |
| `status` field surprises consumers | Additive; null passRate was already undocumented as "passing" |
| False-positive during intentional eval skip | Accepted; the correct response is to re-run the eval. A deliberate skip is a gap the operator should see |

## Out of scope

- **Fixing or restarting the behavioral eval harness** — this surfaces the absence; diagnosing *why* behavior produced no data is separate.
- **Backfilling or inferring a passRate** — `no-data` is reported honestly, never estimated.
- **Changing behavioral pass/fail thresholds or what the behavior tier measures** — only the null/absence handling changes.
- **Applying the no-data convention to unrelated metrics** beyond the tiered pass-rate summaries — though the same classifier could be reused later, this idea targets `behavior.passRate` (and trivially generalizes to other tier passRates if configured).
- **Auto-remediation / alerting beyond the daily report** — paging or issue-filing on persistent `no-data` is a possible follow-on, not included here.
- **Distinguishing *causes* of no-data** (harness crash vs. skipped vs. timed out) — v1 treats all absence as `no-data`; richer cause attribution is later.
- **Path-guard / anti-spoof / write-boundary changes** — none; pure reporting-logic change.
