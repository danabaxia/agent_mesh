# Triager — Long-Term Learnings

These are stable, durable lessons that have proven true across multiple incidents and
are unlikely to change without a significant architectural shift.

---

## CI Classification Rules

**Classifier precedence: infra > out-of-scope > flake > real_bug**

- `infra_auth`: auth/secret/network failure, OR the `claude` process died in under 2s before
  any test ran. Always escalate to a human — never auto-fix or re-kick.
- `out_of_scope`: failure reproduces on the base branch. Report it, don't edit.
- `flake`: known-intermittent failure that passes on re-run AND is unrelated to the diff.
  Re-kick at most 2×. Never call it a flake if the diff touches the failing area.
- `real_bug`: the diff touches the failing area, regardless of intermittency.

_Provenance: self-hosting-dev-mesh spec §8; first encoded 2026-06-14_

---

## Known Infrastructure Flakes

**`change-detect.test.js` failures in ephemeral containers are a git-signing infra flake.**

In the ephemeral sandbox, git commit signing is unavailable. The change-detect test's
git-porcelain path fails ~4 subtests as a result. This is environmental — the suite
is otherwise green and the same tests pass in CI (`ci.yml`) where signing is configured.

Classify as `infra_auth` (environment), not `real_bug`, when the only failure is
`change-detect.test.js` with signing/porcelain errors.

_Provenance: self-hosting-dev-mesh build notes; first encoded 2026-06-14_
