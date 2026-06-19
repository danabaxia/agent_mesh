# Dev-mesh Security Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ask-only Dev-mesh Security agent with a scheduled GitHub Actions security sweep.

**Architecture:** Add `dev-mesh/security` as a normal role folder, route Maintainer to it in `mesh.json`, and add a read-only scheduled `dev-mesh-security.yml` workflow. Guard the behavior with hermetic workflow and agent-topology tests.

**Tech Stack:** Node built-in test runner, raw GitHub Actions YAML lint tests, Dev-mesh role folders, `claude-code-action@v1`.

---

### Task 1: Agent Topology Tests

**Files:**
- Modify: `test/dev-mesh-agents.test.js`

- [x] Add `security` to the committed role list.
- [x] Assert Security is ask-only.
- [x] Assert Maintainer peers include Security.
- [x] Assert Security has no outbound peers.
- [x] Run `node --test test/dev-mesh-agents.test.js test/dev-mesh-workflow.test.js` and verify this fails because the agent does not exist yet.

### Task 2: Workflow Safety Tests

**Files:**
- Modify: `test/dev-mesh-workflow.test.js`

- [x] Add `security` to the workflow role set.
- [x] Assert `dev-mesh-security.yml` exists, is scheduled, supports manual dispatch, and has no PR trigger.
- [x] Assert OAuth token sanitation, `DEV_MESH_MODEL`, `agent-postrun`, and explicit allowed tools.
- [x] Assert the prompt covers injection, identity/auth, and token-budget controls.

### Task 3: Security Agent Content

**Files:**
- Create: `dev-mesh/security/AGENT.md`
- Create: `dev-mesh/security/agent.json`
- Create: `dev-mesh/security/prompts/system.md`
- Create: `dev-mesh/security/prompts/ask.md`
- Create: `dev-mesh/security/skills/injection-sweep/SKILL.md`
- Create: `dev-mesh/security/skills/identity-auth-review/SKILL.md`
- Create: `dev-mesh/security/skills/token-budget-guard/SKILL.md`
- Modify: `dev-mesh/mesh.json`
- Modify: `dev-mesh/maintainer/AGENT.md`
- Modify: `dev-mesh/maintainer/agent.json`

- [x] Add the Security role files and skills.
- [x] Route Maintainer to Security.
- [x] Keep Security ask-only and reporting-only.

### Task 4: Scheduled Workflow

**Files:**
- Create: `.github/workflows/dev-mesh-security.yml`
- Modify: `dev-mesh/README.md`

- [x] Add a scheduled/manual GitHub Actions workflow.
- [x] Use OAuth-only Claude auth with whitespace stripping and masking.
- [x] Keep `contents: read`, allow issue reporting, and run the shared postrun gate.
- [x] Document the new role/workflow in the Dev-mesh README.

### Task 5: Verification And PR

**Files:**
- All modified files above

- [x] Run target tests and confirm they pass.
- [x] Run full `npm test`.
- [ ] Stage only intended files.
- [ ] Commit.
- [ ] Push branch.
- [ ] Open a draft PR targeting `main`.
