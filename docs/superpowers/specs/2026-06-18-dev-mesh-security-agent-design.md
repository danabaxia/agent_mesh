# Dev-mesh Security Agent Design

## Goal

Add an ask-only Security agent to the Dev-mesh society and run it on a scheduled
GitHub Actions sweep so the project continuously checks for security regressions
in its own automation.

## Scope

The Security agent covers three attack-surface lenses:

- Injection disinfection: prompt injection, workflow command injection, unsafe
  shell interpolation, untrusted GitHub text treated as instructions, and fork PR
  secret exposure.
- Identity and auth: OAuth-only Claude auth, least-privilege GitHub permissions,
  same-repo guards, credential masking, and no secret-bearing PR target trigger.
- Token budget control: bounded autonomous loops, branch-scoped retry caps,
  usage capture, concurrency groups, and human-visible budget exhaustion paths.

Out of scope: automatic code edits, automatic PR reviews, automatic merges, or
closing issues/PRs. The agent reports and escalates only.

## Architecture

`dev-mesh/security` is a normal society role with `AGENT.md`, `agent.json`,
mode prompts, and three focused skills. It is served in ask mode only and has no
outbound peers. `dev-mesh/mesh.json` lets the Maintainer route security sweeps to
Security.

`.github/workflows/dev-mesh-security.yml` runs every six hours and on manual
dispatch. It uses OAuth-only `CLAUDE_CODE_OAUTH_TOKEN`, read-only repository
permissions, issue write permission for alerts, `claude-code-action@v1`, and the
shared `agent-postrun` honesty/usage gate.

## Safety Properties

- No `contents: write`; Security cannot push.
- No PR trigger; fork PR content cannot receive secrets through this workflow.
- No auto-merge or PR-close commands in the workflow prompt.
- Allowed tools are limited to repository reads and `gh` for reporting.
- Findings must cite files/workflows and produce minimal remediation guidance.

## Verification

`test/dev-mesh-agents.test.js` guards the committed role set, Security card, ask
mode, and Maintainer peer topology.

`test/dev-mesh-workflow.test.js` guards workflow existence, schedule/manual
triggers, OAuth sanitation, model variable use, postrun honesty gate, least
privilege, no auto-merge, and the three required security lenses.
