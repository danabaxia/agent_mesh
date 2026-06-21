Emits `trend:<metric>:<cell>` findings into the same finding stream.
- **Trend helpers (new, pure)** — `splitHalves(trend)`, `q1(values)`, and `assessTrend(metric, trend, noiseBandPct, N) → { adverse, magnitude, direction } | null`. Pure, table-testable, no I/O.
- **Metric-direction map** — the per-metric "good direction" (higher-is-better vs. lower-is-better) used to classify adverse drift. Likely already present for the per-run check; reused, not duplicated.
- **Config (existing only)** — `AGENT_MESH_MIR_TREND_N` (window length, default 10) and `AGENT_MESH_MIR_NOISE_BAND_PCT` (significance threshold). **No new env vars.**
- **`planIssues` (unchanged)** — consumes the new finding exactly like any other (file/update/close), so the GitHub-facing path is untouched.

## Data flow

1. MIR run aggregates metrics; each metric/cell carries a `trend` array (populated by the #337/#342 work).
2. `policy.js` runs its existing **per-run** check (current value vs. rolling-window median, within `noiseBandPct`).
3. **Additionally**, for each metric whose `trend` spans ≥ `AGENT_MESH_MIR_TREND_N`:
   - split into oldest/newest halves → compute Q1 of each;
   - classify direction via the metric-direction map;
   - if adverse **and** magnitude > `noiseBandPct` → emit a `cluster: 'trend-regression'` finding with id `trend:<metric>:<cell>`.
4. All findings (per-run and trend) flow into `planIssues`:
   - first appearance → file issue;
   - recurrence → update;
   - reversal (drift no longer adverse) → close the trend finding.
5. Per-run and trend findings for the same metric/cell coexist when both fire, because their dedupe ids differ.

## Testing

New unit tests in `test/mir-policy.test.js`, all pure (no GitHub, no I/O):

- **Short history:** `trend` with `< N` entries → no trend check runs → noop.
- **Flat trend:** ≥ N entries, oldest-half Q1 ≈ newest-half Q1 → noop.
- **Favorable drift:** adverse-direction metric improving (e.g. `quality_per_1k_tokens` rising) → noop (no finding for *good* movement).
- **Adverse but sub-threshold:** adverse direction, magnitude **< noiseBandPct** → noop.
- **Adverse, sustained, over threshold:** `quality_per_1k_tokens` declining across ≥ N runs with Q1 shift > noiseBand → **trend finding filed**, id `trend:quality_per_1k_tokens:<cell>`, cluster `trend-regression`.
- **`wasted_hops` direction:** sustained *upward* drift in a lower-is-better metric → finding filed (direction map correctness).
- **Coexistence:** a single run that both drops sharply (per-run finding) *and* sits in a long decline (trend finding) → **both** findings present with distinct ids.
- **Reversal closes:** a previously-filed trend finding whose drift reverses → `planIssues` closes it.
- **Q1 robustness:** a single outlier run in one half does not flip the classification (validates Q1 over mean/min).
- **Config sensitivity:** lowering `AGENT_MESH_MIR_TREND_N` makes a shorter history qualify; tightening `AGENT_MESH_MIR_NOISE_BAND_PCT` flips a borderline adverse trend from noop to finding.

## Out of scope

- **Changes to `aggregate.js`, `baseline.js`, `collect.js`** — untouched; this is policy-layer analytics only.
- **GitHub issue schema / `planIssues` changes** — the trend finding reuses the existing file/update/close path verbatim.
- **New env vars** — only the existing `AGENT_MESH_MIR_TREND_N` and `AGENT_MESH_MIR_NOISE_BAND_PCT` are used.
- **Changepoint detection / regression slope modeling / EWMA** — v1 uses a simple two-half Q1 comparison; heavier statistical trend models are deferred.
- **Per-metric custom trend windows or thresholds** — a single global `N` and `noiseBandPct` in v1.
- **Replacing the per-run check** — the trend gate is *additive*; the rolling-window median per-run check remains.
- **Auto-remediation of drift** — this files/updates/closes findings; it does not fix the underlying regression or re-route work.
- **Path-guard, anti-spoof, single-root, no-Bash-in-do** — unaffected; pure logic with no spawn or write boundary.
