rkers against open/closed issues; reused from existing sweeps.
- **Issue body renderer** — per-cell findings table for perf issues; accumulated-symptoms list for intake issues; both update in place on recurrence.
- **`gh` applier (shared)** — create/update/close via `gh`, ask-mode only; lazy label creation as today.
- **Config** — `noiseBandPct` (existing, now also creation-gating), `AGENT_MESH_INTAKE_DEDUP_WINDOW_MS` (default 24 h), and any per-part disable flags.

## Data flow

**Part A (perf):**
1. A mesh-scan produces per-cell findings across metrics.
2. Pre-filing gate drops findings within `noiseBandPct` and cold-start/null-baseline establishments.
3. Coalescer groups survivors by metric → one coalesced finding per (scan, metric) with per-cell rows.
4. For each, the marker matcher checks for an open `perf:<metric>` issue → **update** (refresh per-cell rows) if present, else **file** one issue.
5. Recovery (metric back within band) → **close**.

**Part B (intake-health):**
1. An intake workflow fails (one or more symptoms: 529, permission denial, …) during a run/sweep.
2. The dedup planner looks up the open `intake:<workflow>` issue within the rolling window.
3. **Open issue exists** → **update** it (append symptom, refresh timestamp/occurrence); **none** → **file** one.
4. Triage-sweep's per-run NOT_PLANNED infra filing routes through the same planner → updates the existing workflow issue instead of opening #385/#325-style duplicates.
5. Intake recovers → **close** the workflow issue.

## Testing

Pure-planner/coalescer tests (no live GitHub), mirroring existing sweep patterns:

**Part A:**
- **Same-scan, same-metric, two cells:** #404/#405-style input → **one** issue with two per-cell findings (not two issues).
- **Different metrics, same scan:** distinct metrics → separate issues (coalescing is per-metric, not per-scan).
- **Within-band gating:** a finding inside `noiseBandPct` → **not filed** (fixes #319/#320 rejected-as-noise); assert no issue planned.
- **Cold-start/null baseline:** establishment finding → not filed as `perf-regression`.
- **Recurrence updates:** an open `perf:<metric>` issue + a new scan → **update** (refresh cells), no duplicate.
- **Recovery closes:** metric returns within band → **close**.

**Part B:**
- **Two symptoms, one workflow, same day:** #418 (529) + #421 (perm) → **one** `intake:<workflow>` issue accumulating both.
- **Per-run infra filing:** repeated triage-sweep runs for the same broken intake → **update** the existing issue, not new #385/#325-style issues each run.
- **Window boundary:** a failure after the rolling window elapses → new issue (prior one aged out / closed).
- **Distinct workflows:** failures on different intakes → separate issues.
- **Recovery closes:** intake healthy on next sweep → workflow issue closed.
- **Config:** custom `AGENT_MESH_INTAKE_DEDUP_WINDOW_MS` and disable flags honored; `noiseBandPct` change shifts the creation gate.

## Out of scope

- **Changing what counts as a perf regression or the metrics themselves** — this gates/coalesces filing; detection thresholds (baseline/budget) are owned by #412/#324.
- **Auto-fixing the underlying regressions or broken intake** — dedup/gating only; remediation is separate.
- **Cross-scan perf coalescing** — Part A coalesces within a **single scan**; merging the same metric across different scans/days is not in scope (recurrence is handled by update, not cross-scan grouping).
- **Merging genuinely distinct intake failures across different workflows** — dedup is per-workflow; unrelated intakes stay separate.
- **Retroactive cleanup of already-filed duplicates** (#404/#405, #418/#421, #319/#320) — this prevents future noise; back-merging existing issues is a separate housekeeping task.
- **New issue schema or labels** — reuses existing markers, lifecycle, and labels.
- **Human-approval gate changes** — untouched.
- **Path-guard / anti-spoof / write-boundary changes** — none; ask-mode reads + `gh` CLI, pure plan builders.
