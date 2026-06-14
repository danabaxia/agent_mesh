# Coding Agent for Agent Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code-backed Coding Agent sample that can be registered as an Agent Mesh A2A peer and whose runtime anatomy is verified by tests.

**Architecture:** Keep Coding Agent as a normal folder agent, not a framework shortcut. The implementation adds `examples/coding-agent/` fixtures and a focused test file that validates AgentCard shape, runtime prompt assembly through `src/agent-context.js`, and the ask/do tool contract through existing `delegateTask` behavior.

**Tech Stack:** Node.js ESM, `node:test`, Agent Mesh A2A stdio, Claude Code CLI invocation through existing fake-claude test pattern.

---

## File Structure

- Create `examples/coding-agent/agent.json`: public A2A identity and declared capabilities.
- Create `examples/coding-agent/AGENT.md`: public human-readable description, not obeyed as system prompt.
- Create `examples/coding-agent/.mcp.json`: empty local MCP declaration for MVP.
- Create `examples/coding-agent/prompts/{system,ask,do}.md`: runtime prompt entry and mode prompts.
- Create `examples/coding-agent/memory/{profile,coding-standards,safety-policy,verification-policy}.md`: static memory.
- Create `examples/coding-agent/workflows/{default,ask,do}.md`: execution workflows.
- Create `examples/coding-agent/skills/{patch-planning,code-review,test-strategy}/SKILL.md`: local skill summaries.
- Create `test/coding-agent.test.js`: fixture and runtime-context tests.

## Task 1: Validate Coding Agent Fixture

**Files:**
- Create: `test/coding-agent.test.js`
- Create: `examples/coding-agent/agent.json`
- Create: `examples/coding-agent/AGENT.md`
- Create: `examples/coding-agent/.mcp.json`

- [x] **Step 1: Write the failing fixture test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const codingAgentRoot = join(root, 'examples', 'coding-agent');

test('coding-agent fixture declares a coding A2A peer', async () => {
  const card = JSON.parse(await readFile(join(codingAgentRoot, 'agent.json'), 'utf8'));

  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.name, 'coding-agent');
  assert.equal(card['x-agentmesh'].modes.includes('ask'), true);
  assert.equal(card['x-agentmesh'].modes.includes('do'), true);
  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    ['code-implementation', 'code-review', 'test-strategy']
  );
});

test('coding-agent public description is separate from runtime prompts', async () => {
  const publicDescription = await readFile(join(codingAgentRoot, 'AGENT.md'), 'utf8');
  assert.match(publicDescription, /public description/i);
  assert.doesNotMatch(publicDescription, /You are the Coding Agent in Agent Mesh/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test test/coding-agent.test.js`

Expected: FAIL because `examples/coding-agent/agent.json` does not exist.

- [x] **Step 3: Add minimal fixture files**

Create `examples/coding-agent/agent.json`:

```json
{
  "protocolVersion": "0.3.0",
  "name": "coding-agent",
  "description": "A Claude Code-backed peer agent for scoped coding tasks, patch planning, implementation, review, and test strategy.",
  "version": "0.1.0",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "code-implementation",
      "name": "Code implementation",
      "description": "Implement scoped code changes inside the assigned project root.",
      "tags": ["coding", "patch", "claude-code"]
    },
    {
      "id": "code-review",
      "name": "Code review",
      "description": "Review code for bugs, regressions, missing tests, and maintainability risks.",
      "tags": ["review", "quality"]
    },
    {
      "id": "test-strategy",
      "name": "Test strategy",
      "description": "Recommend focused verification commands and test coverage for a scoped change.",
      "tags": ["tests", "verification"]
    }
  ],
  "x-agentmesh": {
    "modes": ["ask", "do"]
  }
}
```

Create `examples/coding-agent/AGENT.md`:

```md
# Coding Agent

This is the public description for a Claude Code-backed coding peer agent.
Other agents can discover that it handles scoped implementation, code review,
and test strategy tasks over A2A.

This file is descriptive data only. The obeyed runtime identity lives in
`prompts/system.md`.
```

Create `examples/coding-agent/.mcp.json`:

```json
{
  "mcpServers": {}
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test test/coding-agent.test.js`

Expected: PASS for the two fixture tests.

## Task 2: Verify Runtime Anatomy Assembly

**Files:**
- Modify: `test/coding-agent.test.js`
- Create: `examples/coding-agent/prompts/system.md`
- Create: `examples/coding-agent/prompts/ask.md`
- Create: `examples/coding-agent/prompts/do.md`
- Create: `examples/coding-agent/memory/profile.md`
- Create: `examples/coding-agent/memory/coding-standards.md`
- Create: `examples/coding-agent/memory/safety-policy.md`
- Create: `examples/coding-agent/memory/verification-policy.md`
- Create: `examples/coding-agent/workflows/default.md`
- Create: `examples/coding-agent/workflows/ask.md`
- Create: `examples/coding-agent/workflows/do.md`

- [x] **Step 1: Write the failing runtime prompt test**

Append to `test/coding-agent.test.js`:

```js
import { buildAgentRuntimePrompt } from '../src/agent-context.js';

test('coding-agent runtime prompt includes system, memory, workflows, and mode prompt in order', async () => {
  const prompt = await buildAgentRuntimePrompt(codingAgentRoot, 'ask');
  const expectedOrder = [
    'You are the Coding Agent in Agent Mesh.',
    'Coding Agent profile',
    'Coding standards',
    'Safety policy',
    'Verification policy',
    'Default coding workflow',
    'Ask workflow',
    'You are in ask mode.'
  ];

  let cursor = -1;
  for (const marker of expectedOrder) {
    const idx = prompt.indexOf(marker, cursor + 1);
    assert.ok(idx > cursor, `expected "${marker}" after position ${cursor}, got ${idx}`);
    cursor = idx;
  }
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test test/coding-agent.test.js`

Expected: FAIL because runtime prompt files do not exist.

- [x] **Step 3: Add runtime anatomy files**

Create the prompt, memory, and workflow markdown files with the exact marker strings from Step 1 and the policy text from the spec.

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test test/coding-agent.test.js`

Expected: PASS for fixture and runtime prompt tests.

## Task 3: Verify Local Skill Summaries

**Files:**
- Modify: `test/coding-agent.test.js`
- Create: `examples/coding-agent/skills/patch-planning/SKILL.md`
- Create: `examples/coding-agent/skills/code-review/SKILL.md`
- Create: `examples/coding-agent/skills/test-strategy/SKILL.md`

- [x] **Step 1: Write the failing skill summary test**

Append to `test/coding-agent.test.js`:

```js
test('coding-agent runtime prompt includes deterministic local skill summaries', async () => {
  const prompt = await buildAgentRuntimePrompt(codingAgentRoot, 'ask');

  assert.match(prompt, /Available local skills:/);
  assert.match(prompt, /- code-review: Review scoped code changes for bugs, regressions, missing tests, and maintainability risks\./);
  assert.match(prompt, /- patch-planning: Plan minimal coding patches before implementation\./);
  assert.match(prompt, /- test-strategy: Recommend focused verification commands and test coverage for scoped coding changes\./);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test test/coding-agent.test.js`

Expected: FAIL because local skill files do not exist.

- [x] **Step 3: Add local skill files**

Create each `SKILL.md` with frontmatter `name` and `description` matching the assertions.

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test test/coding-agent.test.js`

Expected: PASS.

## Task 4: Full Regression Verification

**Files:**
- No new files.

- [x] **Step 1: Run focused tests**

Run: `node --test test/coding-agent.test.js test/agent-context.test.js test/delegate.test.js`

Expected: PASS.

- [x] **Step 2: Run full suite**

Run: `npm test`

Expected: PASS, or report exact failing tests if existing dirty-worktree changes are failing.
