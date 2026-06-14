# Operating the Dev-mesh

How to run and keep the self-hosting Dev-mesh healthy. Hard-won notes — read
before changing auth, model, or workflows. Design: `docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md`.

## Auth (how the agents reach Claude in CI)

The agents run in GitHub Actions via `claude-code-action@v1`. Two **separate**
billing wallets — don't confuse them:

| Auth | Secret | Wallet | Notes |
|------|--------|--------|-------|
| **Subscription (current)** | `CLAUDE_CODE_OAUTH_TOKEN` | Claude Pro/Max plan | Generate with `claude setup-token` on a logged-in Pro/Max machine (`sk-ant-oat01-…`). No per-call charge; subject to subscription rate limits. Check Anthropic's policy on automated use. |
| API key (alternative) | `ANTHROPIC_API_KEY` | Anthropic **API** credits (console billing) | Pay-as-you-go. Sturdier for automation. *Not* funded by a Pro/Max subscription — they're different wallets. |

A **Pro/Max subscription does NOT fund API keys.** An empty API balance returns
`billing_error` / "Credit balance is too low" (HTTP 400) — an instant `is_error`
with `$0`. (This bit us on 2026-06-14: keycheck passed on leftover credit, then the
mesh failed `billing_error` once it ran out. Switched to subscription auth.)

## Model

Model id comes from the **`DEV_MESH_MODEL` repo variable** with a `'sonnet'`
fallback — change it in repo *Settings → Variables*, **no PR needed**. Avoid
forcing a model the account can't access: `claude-code-action` otherwise defaults
to a gated Opus variant (`claude-opus-4-8[1m]`) that errors instantly for many keys.
Prefer the `sonnet`/`opus` **aliases** (resolve to what the account has) over dated
ids.

## Health: a green job is NOT a healthy run

`claude-code-action` reports the GitHub job **green even when the model run errored**
(it swallows `is_error` into a "success" subtype). So never trust the job conclusion
alone — judge the **result envelope**:

- **Per-run honesty gate** — every agent workflow runs `scripts/assert-run-healthy.mjs`
  after its agent step; it reads the envelope and **fails the job** on `is_error` or
  zero turns, dumping the output for diagnosis. Green now means *worked*.
- **Scheduled monitor** — `dev-mesh-health.yml` (every 6h) runs conformance
  (`doctor --apply`) + reads the **dogfood canary** envelope, escalating a single
  `Dev-mesh health alert` issue on real unhealth.
- Subscription auth reports `$0` even on success, so health keys off `is_error` /
  `num_turns`, never cost.

Pure health logic: `src/dev-mesh/health.js` (`classifyRunHealth`). Tests:
`test/dev-mesh-health.test.js`.

## The loop (who does what)

GitHub Issues are the backlog (one label = one state). Workflows:
`research · intake · backlog · triage · review · curate` (+ `dogfood`, `health`).
The two **human gates**: spec **approval** (no code until a human approves) and PR
**merge** (no auto-merge). Everything between is autonomous and reversible. Labels:
`idea · discussing · spec:draft · spec:in-review · approved · in-progress ·
pr:in-review · done · blocked · rejected · memory:promote`.

## Quick triage

- All agent runs fail instantly (`is_error`/`$0`, ~150ms): **auth** — token missing,
  or API credit empty. Check the secret matches the chosen auth row above.
- Job green but nothing happened: shouldn't occur anymore (honesty gate). If it does,
  the gate/`execution_file` wiring regressed — see `dev-mesh-workflow.test.js`.
- `review`/agent check red but `ci.yml` green: `ci.yml` (pure `node --test`) is the
  authoritative merge gate; agent checks are advisory.
