n.
- **Quarantine-aware gate consumer** — wherever the merge gate evaluates test results, it consults the ledger/issue state and **excludes** entries that are quarantined (have `issueNumber` set + quarantine label) from the blocking set, while still surfacing them as known-flaky.
- **Pure plan builder** — given the full ledger + config, emits the list of actions `{ entryKey, action: 'file' | 'update' | 'quarantine-exit' | 'noop' }`. The unit-test seam; no I/O inside.
- **Config resolver** — reads the `AGENT_MESH_FLAKE_*` env vars with the documented defaults.

## Data flow

1. Improvement-report run updates the ledger (occurrences, cleanRuns, firstSeen/lastSeen per test).
2. The flake policy runs over the ledger; the classifier evaluates each entry against config thresholds.
3. Pure plan builder emits per-entry actions:
   - confirmed flaky **and** `issueNumber == null` → **file** (create deduped issue, apply quarantine label, write back `issueNumber`).
   - confirmed flaky **and** `issueNumber != null` → **update** the existing issue (refresh counts/dates) via dedupe; no new issue.
   - hard break (`cleanRuns == 0`) → **noop** for quarantine (stays gate-blocking).
   - sustained green meeting `EXIT_CLEAN_RUNS` → **quarantine-exit** (close/propose-close issue, clear quarantine).
4. Applier executes the plan via `gh` (create/update/close + label) and the ledger writer persists `issueNumber`/quarantine state.
5. Merge gate, on its next evaluation, treats quarantined entries as non-blocking but still visible — the flake is now a tracked, owned work item instead of a silent red.

## Testing

Pure-classifier and plan-builder tests (no live GitHub):

- **Canonical trigger:** the `tester-agent-schedule-test-js` entry (occ=2, 2 days, cleanRuns=1, issueNumber=null) → classified flaky, plan `file`.
- **Hard-break guard:** occ=3, cleanRuns=0 → classified hard-break, **not** quarantined, stays gate-blocking.
- **Single-day burst:** occ=2 but both on the same day (< MIN_DISTINCT_DAYS) → not yet flaky, `noop`.
- **Below occurrence threshold:** occ=1 → `noop`.
- **Already filed:** flaky entry with `issueNumber` set → plan `update` (dedupe path), assert **no** second issue created.
- **Dedupe marker:** filing embeds the entry's dedupe key; a re-run finds it and updates rather than duplicating.
- **Write-back:** after `file`, the ledger entry's `issueNumber` is populated.
- **Config override:** raising `AGENT_MESH_FLAKE_MIN_OCCURRENCES` to 3 makes the occ=2 case `noop`; lowering distinct-days/clean-runs flips classifications as expected.
- **Quarantine non-blocking:** a quarantined entry is excluded from the gate's blocking set while remaining present in the surfaced results.
- **Quarantine exit:** an entry green for `EXIT_CLEAN_RUNS` consecutive runs → plan `quarantine-exit`.
- **Resilience:** malformed ledger entry skipped, no throw; missing `firstSeen`/`lastSeen` handled without crashing.

## Out of scope

- **Auto-fixing the flaky test** — the policy files and quarantines; it does not attempt a code fix or re-route to the coder.
- **Disabling/skipping the test in source** (e.g. writing `.skip`/`xfail`) — quarantine is gate-policy only; the test still runs and reports.
- **Changing the ledger's occurrence/cleanRun accounting** — this consumes existing fields; it does not alter how they are computed.
- **New notification channels** — issue creation via the existing dedupe/`gh` path only; no push/Slack.
- **Aggressive auto-close of quarantine issues** — v1 exit may be conservative (propose-close or require sustained green); fully automatic close tuning is deferred.
- **Cross-test flake correlation / root-cause clustering** (e.g. grouping flakes by shared infrastructure) — out of scope.
- **Per-test custom thresholds** — v1 uses global `AGENT_MESH_FLAKE_*` config; per-test overrides are a later refinement.
- **Path-guard, anti-spoof, or write-boundary changes** — none; ask-mode reads + `gh` CLI, plus the single `issueNumber` ledger write-back.
