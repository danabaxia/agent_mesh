lthy-block threshold comparison; emits a summary distinguishing ignored-inert vs. counted denials.
- **Denial classifier (pure)** — `(denial, inertSkillAllowlist) → { counts: bool, reason }`: returns whether a denial counts toward the threshold and why. Pure, table-testable — the core seam.
- **Denial-provenance accessor** — surfaces the originating skill from each denial record so the classifier can match the allowlist; extended if provenance is not already present.
- **`.github/actions/agent-postrun`** — passes the configured inert-skill allowlist through to the script; surfaces the ignored-inert summary in the action output/logs.
- **Config (`src/config.js` or action input)** — `AGENT_MESH_HEALTH_INERT_SKILLS` allowlist, default `fewer-permission-prompts`.

## Data flow

1. An agent run completes; the postrun gate collects the run's permission-denial records.
2. For each denial, the provenance accessor resolves its originating skill.
3. The denial classifier checks each against the inert-skill allowlist:
   - **inert-skill source** → `counts: false` (ignored-inert), recorded for reporting but excluded from the threshold tally.
   - **any other source** → `counts: true`, included in the tally.
4. The gate compares the **counted** denial total against the unhealthy-block threshold.
5. The gate emits its verdict plus a summary: counted denials, ignored-inert denials (with skill names), and pass/fail. Run `27978106979`'s 8 `fewer-permission-prompts` denials are ignored-inert → the run is no longer red on that basis.

## Testing

Pure-classifier and gate-level tests (hermetic):

- **The regression case:** 8 denials all from `fewer-permission-prompts`, no others → gate **passes** (zero counted), denials reported as ignored-inert.
- **Mixed denials:** some `fewer-permission-prompts` (ignored) + some genuine denials (counted) → only the genuine ones tally; gate reds only if the counted total crosses the threshold.
- **Genuine-only:** real denials from non-inert sources still red the run (carve-out did not weaken the gate).
- **Threshold boundary:** counted denials exactly at the unhealthy-block threshold → assert the chosen `>=`/`>` semantics, with inert denials excluded from the count.
- **Provenance attribution:** a denial is correctly attributed to its originating skill; an unattributable denial **counts** (fail-safe — never silently ignored without provenance).
- **Config-driven allowlist:** adding another skill to `AGENT_MESH_HEALTH_INERT_SKILLS` ignores its denials; removing `fewer-permission-prompts` makes its denials count again.
- **Reporting:** the gate output distinguishes ignored-inert vs. counted denials and names the inert skills (observability preserved).
- **Default:** with no config, `fewer-permission-prompts` is ignored by default.

## Out of scope

- **Removing or weakening the #421 prompt HARD RULE** — it stays as the first line of defense; this is additive structural enforcement.
- **Preventing the model from invoking `fewer-permission-prompts`** — this gate handles the *consequence* (inert denials reding runs), not the invocation itself.
- **Broadly relaxing the permission-denial threshold** — the carve-out is limited to an explicit allowlist of provably-inert skills; all other denials gate as before.
- **Skills that are inert only sometimes / context-dependent** — only skills inert **on the ephemeral runner regardless of input** belong on the allowlist; conditionally-inert behavior is out of scope.
- **Persistent (non-CI) environments** — on an environment where `fewer-permission-prompts` *would* persist, the denials are not inert; this carve-out is scoped to the ephemeral-runner postrun gate.
- **Changing how denials are produced or the permission system itself** — only the postrun *counting* logic changes.
- **Retroactively re-greening past failed runs** (e.g. `27978106979`) — this prevents future false-reds; historical re-runs are not in scope.
- **Anti-spoof / path-guard / write-boundary changes** — none.
