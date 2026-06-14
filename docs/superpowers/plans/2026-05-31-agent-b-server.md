# Agent B Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Agent B (a self-contained A2A "library" agent) so it spawns its worker with its own identity (from `prompts/`) and answers book lookups via its own read-only `search_books` MCP tool.

**Architecture:** Two small framework changes in the spawn pipeline — (1) inject `prompts/system.md` + `prompts/<mode>.md` as `--append-system-prompt`, conditional on the files existing so current behavior is unchanged when absent; (2) treat `.mcp.json` as the agent's own tool *declarations* and grant a per-task subset to the worker — own-tools in `ask`, none in `do` by default (spec Boundary 4: declarations are not grants; default-deny). Then a demo agent folder `examples/agent-b/` with a tiny stdio MCP book-search server and a catalog.

**Scope note on spec Boundary 5 (protected config):** the demo is `ask`-only, where the worker has **no write tools at all**, so a delegated task here cannot rewrite `prompts/`/`agent.json`/`.mcp.json`. Runtime enforcement of the protected-config write boundary belongs to the `do`-mode increment (and the PROJECT.md follow-up); it is **documented but not enforced** in this increment because nothing here can reach it.

**Tech Stack:** Node ≥20, ESM, `node:test`/`node:assert`, zero deps. Tests stub `claude` via the existing `createFakeClaude` helper. The book-search server is a minimal newline-delimited JSON-RPC stdio server modeled on `src/mcp.js`.

**Source of truth:** [docs/superpowers/specs/2026-05-31-agent-anatomy-library-demo-design.md](../specs/2026-05-31-agent-anatomy-library-demo-design.md). This plan covers the spec's §10 "first implementation increment" (Agent B server). Agent A (caller discipline) and `registry.json` are a later increment and out of scope here.

---

## File structure for this increment

- **Modify** `src/config.js` — add `MAX_PROMPT_CHARS`.
- **Modify** `src/delegate.js` — add `readIdentityPrompt` + `--append-system-prompt`; replace `readAgentMeshPeers`/`isAgentMeshServer` with a per-task grant (`grantToolServers` + `readDeclaredToolServers`) and thread `mode` into `createStrictMcpConfig`.
- **Modify** `test/delegate.test.js` — add prompts-injection test; update the `ask`-mode grant assertion; add a `do`-mode default-deny test.
- **Create** `examples/agent-b/tools/book-search/server.mjs` — read-only `search_books` MCP server (exports pure `searchBooks`).
- **Create** `test/book-search.test.js` — unit tests for `searchBooks`.
- **Create** `examples/agent-b/{agent.json, AGENT.md, books.json, .mcp.json}` and `examples/agent-b/prompts/{system.md, ask.md}` — the demo agent.
- **Create** `test/agent-b-e2e.test.js` — opt-in real-`claude` end-to-end (gated by `AGENT_MESH_E2E=1`).

---

## Task 1: Inject `prompts/` identity into the worker

**Files:**
- Modify: `src/config.js`
- Modify: `src/delegate.js` (`buildClaudeInvocation`, new `readIdentityPrompt`/`boundPrompt`)
- Test: `test/delegate.test.js`

- [ ] **Step 1: Add the prompt-size bound to config**

In `src/config.js`, after the `MAX_DESCRIPTION_CHARS` line, add:

```js
export const MAX_PROMPT_CHARS = 8_000;
```

- [ ] **Step 2: Write the failing test**

Append this test to `test/delegate.test.js` (it reuses the file's existing `createFakeClaude`, `createGitRepo`, helpers):

```js
test('delegateTask injects prompts/system.md and prompts/<mode>.md as --append-system-prompt', async () => {
  const root = await createGitRepo();
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'system.md'), 'You are the library agent.');
  await writeFile(join(root, 'prompts', 'ask.md'), 'Answer read-only from the catalog.');

  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const i = process.argv.indexOf('--append-system-prompt');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({
      hasFlag: i > -1,
      prompt: i > -1 ? process.argv[i + 1] : null
    }));
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'ask', task: 'find a book' }
  });

  assert.equal(result.status, 'done');
  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  assert.equal(capture.hasFlag, true);
  assert.match(capture.prompt, /You are the library agent\./);
  assert.match(capture.prompt, /Answer read-only from the catalog\./);
});
```

Ensure `mkdir` is imported at the top of `test/delegate.test.js`. The current import is:

```js
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
```

Change it to:

```js
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --test-name-pattern="injects prompts" test/delegate.test.js`
Expected: FAIL — `capture.hasFlag` is `false` (no `--append-system-prompt` yet).

- [ ] **Step 4: Implement the injection**

In `src/delegate.js`, update the config import to include `MAX_PROMPT_CHARS`:

```js
import {
  DEFAULT_DEPTH,
  DEFAULT_LOG_DIR,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  READ_TOOLS,
  WRITE_TOOLS,
  readPositiveInt
} from './config.js';
```

Replace the body of `buildClaudeInvocation` so it adds the flag when prompts exist:

```js
async function buildClaudeInvocation({ root, mode, task, env }) {
  const args = buildClaudeInvocationSync(mode, task);
  const identity = await readIdentityPrompt(root, mode);
  if (identity) args.push('--append-system-prompt', identity);
  args.push('--strict-mcp-config', '--mcp-config', await createStrictMcpConfig(root));
  if (mode === 'do') {
    args.push('--settings', await createClaudeSettings(root, env));
    // Headless `claude -p` still gates Edit/Write behind a permission
    // decision even when the tool is in --tools; with no interactive
    // approver the write never lands. acceptEdits auto-approves the edit.
    // The PreToolUse path-guard hook runs regardless of permission mode,
    // so cross-folder write confinement is unchanged — the boundary is
    // the hook, not the prompt. (do mode could not write at all before
    // this; caught by the real-claude E2E, not the fake-claude unit test.)
    args.push('--permission-mode', 'acceptEdits');
  }
  return { args };
}

// B's identity is its own internal prompts/ — NOT AGENT.md (which is public,
// untrusted, never obeyed). Missing files are skipped so behavior is unchanged
// for folders without a prompts/ dir.
async function readIdentityPrompt(root, mode) {
  const parts = [];
  for (const file of ['prompts/system.md', `prompts/${mode}.md`]) {
    try {
      const text = await readFile(join(root, file), 'utf8');
      if (text.trim()) parts.push(text.trim());
    } catch {
      // missing prompt file — skip
    }
  }
  if (parts.length === 0) return null;
  return boundPrompt(parts.join('\n\n'));
}

function boundPrompt(text) {
  const trimmed = String(text).trim();
  if (trimmed.length <= MAX_PROMPT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PROMPT_CHARS - 15).trimEnd()}... [truncated]`;
}
```

(`readFile` and `join` are already imported at the top of `src/delegate.js`.)

- [ ] **Step 5: Run the new test and the full suite**

Run: `node --test --test-name-pattern="injects prompts" test/delegate.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS — the two existing argv tests are unaffected because their temp roots have no `prompts/` dir, so no flag is added.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/delegate.js test/delegate.test.js
git commit -m "feat: inject prompts/ identity into delegated worker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Grant a per-task subset of `.mcp.json` tools (Boundary 4: declarations are not grants)

`.mcp.json` *declares* the agent's own tool servers; the framework decides, per
task, which to actually expose. **Increment policy:** own-tools are granted in
`ask` (read-only context) and withheld in `do` by default. This keeps
default-deny — a declaration is necessary, not sufficient — while giving the
library's `search_books` tool to `ask` lookups. (Finer per-tool capability flags
are a later refinement.)

**Files:**
- Modify: `src/delegate.js` (`buildClaudeInvocation` passes `mode`; `createStrictMcpConfig` takes `mode`; replace `readAgentMeshPeers`/`isAgentMeshServer` with `grantToolServers` + `readDeclaredToolServers`)
- Test: `test/delegate.test.js` (update the existing ask-mode grant assertion; add a do-mode default-deny test)

- [ ] **Step 1: Update the ask-mode test to the grant semantics (write the failing expectation)**

In `test/delegate.test.js`, in the test named
`delegateTask ask mode invokes claude with read-only tools and writes a log`,
change the `.mcp.json` fixture (currently keys `peer` + `unrelated`) to two
declared own-tool servers, and assert both are granted in `ask`.

Replace the fixture write:

```js
await writeFile(
  join(root, '.mcp.json'),
  JSON.stringify({
    mcpServers: {
      docstore: { command: 'node', args: ['tools/docstore/server.mjs'] },
      search: { command: 'node', args: ['tools/search/server.mjs'] }
    }
  })
);
```

Replace the assertion (currently `assert.deepEqual(Object.keys(mcpConfig.mcpServers), ['peer']);`) with:

```js
assert.deepEqual(Object.keys(mcpConfig.mcpServers), ['docstore', 'search']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="ask mode invokes claude" test/delegate.test.js`
Expected: FAIL — current code filters to `isAgentMeshServer`, so `mcpConfig.mcpServers` is `{}` (neither server mentions `agent-mesh`), not `['docstore','search']`.

- [ ] **Step 3: Replace the peer filter with a per-task grant**

In `src/delegate.js`, thread `mode` into the config builder. In
`buildClaudeInvocation`, change the call to:

```js
  args.push('--strict-mcp-config', '--mcp-config', await createStrictMcpConfig(root, mode));
```

Change `createStrictMcpConfig` to take `mode` and grant accordingly:

```js
async function createStrictMcpConfig(root, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-mcp-'));
  const config = { mcpServers: await grantToolServers(root, mode) };
  const path = join(dir, 'mcp.json');
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}
```

Replace `readAgentMeshPeers` and delete `isAgentMeshServer` entirely, with the
grant + declaration reader:

```js
// Boundary 4: declarations are NOT grants. .mcp.json only DECLARES the agent's
// own tool servers (peers live in registry.json and travel over A2A, not as MCP
// tools). The framework grants a per-task subset: own-tools in `ask` (read-only
// context), none in `do` by default. --strict-mcp-config isolates this from any
// global/user MCP config, so only this folder's own declarations are eligible.
async function grantToolServers(root, mode) {
  if (mode !== 'ask') return {};
  return readDeclaredToolServers(root);
}

async function readDeclaredToolServers(root) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
  } catch {
    return {};
  }

  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};

  const tools = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server && typeof server === 'object') tools[name] = server;
  }
  return tools;
}
```

- [ ] **Step 4: Run the ask test and the full suite**

Run: `node --test --test-name-pattern="ask mode invokes claude" test/delegate.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS — the existing `do`-mode argv test still passes (it asserts the
`--mcp-config` path exists, not its contents).

- [ ] **Step 5: Add the do-mode default-deny test (write the failing test)**

Append to `test/delegate.test.js`:

```js
test('delegateTask do mode grants no .mcp.json tool servers (default-deny)', async () => {
  const root = await createGitRepo();
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { docstore: { command: 'node', args: ['tools/docstore/server.mjs'] } } })
  );
  const fakeClaude = await createFakeClaude(`
    const fs = await import('node:fs/promises');
    const i = process.argv.indexOf('--mcp-config');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({ mcpConfig: process.argv[i + 1] }));
    console.log('ok');
  `);

  const result = await delegateTask({
    root,
    env: { AGENT_MESH_CLAUDE: fakeClaude, CAPTURE_PATH: join(root, 'capture.json') },
    input: { mode: 'do', task: 'change files' }
  });

  assert.equal(result.status, 'done');
  const capture = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(capture.mcpConfig, 'utf8'));
  assert.deepEqual(mcp.mcpServers, {});
});
```

- [ ] **Step 6: Run the new test and the full suite**

Run: `node --test --test-name-pattern="do mode grants no" test/delegate.test.js`
Expected: PASS — `do` mode yields an empty `mcpServers` grant.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/delegate.js test/delegate.test.js
git commit -m "feat: grant per-task .mcp.json tool subset (declarations are not grants)

ask grants the agent's own declared tools; do withholds them by default.
.mcp.json now means the agent's own tools; peers move to registry.json.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Book-search MCP server (`searchBooks` + stdio server)

**Files:**
- Create: `examples/agent-b/tools/book-search/server.mjs`
- Test: `test/book-search.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/book-search.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBooks } from '../examples/agent-b/tools/book-search/server.mjs';

const CATALOG = [
  { title: 'Dune', author: 'Frank Herbert', shelf: 3 },
  { title: 'Dune Messiah', author: 'Frank Herbert', shelf: 3 },
  { title: 'Neuromancer', author: 'William Gibson', shelf: 7 }
];

test('searchBooks matches title case-insensitively', () => {
  const hits = searchBooks(CATALOG, 'dune');
  assert.deepEqual(hits.map((b) => b.title), ['Dune', 'Dune Messiah']);
});

test('searchBooks matches author', () => {
  const hits = searchBooks(CATALOG, 'gibson');
  assert.deepEqual(hits.map((b) => b.title), ['Neuromancer']);
});

test('searchBooks returns empty array on no match', () => {
  assert.deepEqual(searchBooks(CATALOG, 'nonexistent'), []);
});

test('searchBooks returns empty array on blank query', () => {
  assert.deepEqual(searchBooks(CATALOG, '   '), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/book-search.test.js`
Expected: FAIL — `Cannot find module '.../examples/agent-b/tools/book-search/server.mjs'`.

- [ ] **Step 3: Implement the server (pure function + stdio runner)**

Create `examples/agent-b/tools/book-search/server.mjs`:

```js
#!/usr/bin/env node
// Read-only MCP stdio server: exposes search_books over the agent's own catalog.
// Newline-delimited JSON-RPC (one JSON object per line), matching agent-mesh's
// own MCP transport. Owns NO write capability — it only reads books.json.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export function searchBooks(books, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return books.filter(
    (b) =>
      String(b.title || '').toLowerCase().includes(q) ||
      String(b.author || '').toLowerCase().includes(q)
  );
}

async function loadCatalog() {
  // books.json lives at the agent root: tools/book-search/ -> ../../books.json
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', '..', 'books.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.books || [];
  } catch {
    return [];
  }
}

function handle(message, catalog) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'book-search', version: '0.1.0' }
      }
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'search_books',
            description: 'Search the library catalog by title or author. Returns matching {title, author, shelf}.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['query'],
              properties: { query: { type: 'string', minLength: 1 } }
            }
          }
        ]
      }
    };
  }
  if (method === 'tools/call') {
    if (params?.name !== 'search_books') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
    }
    const hits = searchBooks(catalog, params?.arguments?.query);
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(hits) }] }
    };
  }
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

async function main() {
  const catalog = await loadCatalog();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          nl = buffer.indexOf('\n');
          continue;
        }
        const response = handle(msg, catalog);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      nl = buffer.indexOf('\n');
    }
  });
}

// Only start the server when run directly — importing for tests must not block on stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

- [ ] **Step 4: Run the test and the full suite**

Run: `node --test test/book-search.test.js`
Expected: PASS (4 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/agent-b/tools/book-search/server.mjs test/book-search.test.js
git commit -m "feat: add read-only book-search MCP server for agent B

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The `examples/agent-b/` library agent definition

**Files:**
- Create: `examples/agent-b/agent.json`
- Create: `examples/agent-b/AGENT.md`
- Create: `examples/agent-b/books.json`
- Create: `examples/agent-b/.mcp.json`
- Create: `examples/agent-b/prompts/system.md`
- Create: `examples/agent-b/prompts/ask.md`

> Note: an `examples/agent-b/AGENT.md` already exists from earlier baseline work. Overwrite it with the content below so it matches the library role.

- [ ] **Step 1: Create the catalog** — `examples/agent-b/books.json`

```json
[
  { "title": "Dune", "author": "Frank Herbert", "shelf": 3 },
  { "title": "Dune Messiah", "author": "Frank Herbert", "shelf": 3 },
  { "title": "Neuromancer", "author": "William Gibson", "shelf": 7 },
  { "title": "The Left Hand of Darkness", "author": "Ursula K. Le Guin", "shelf": 5 },
  { "title": "Foundation", "author": "Isaac Asimov", "shelf": 1 }
]
```

- [ ] **Step 2: Declare the agent's own tool** — `examples/agent-b/.mcp.json`

```json
{
  "mcpServers": {
    "book-search": {
      "command": "node",
      "args": ["tools/book-search/server.mjs"]
    }
  }
}
```

- [ ] **Step 3: Public AgentCard** — `examples/agent-b/agent.json`

```json
{
  "protocolVersion": "0.3.0",
  "name": "library",
  "description": "A library agent that answers questions about its book catalog (title, author, shelf).",
  "version": "0.1.0",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "book-lookup",
      "name": "Book lookup",
      "description": "Find a book in the catalog by title or author and report its shelf.",
      "tags": ["library", "catalog", "search"]
    }
  ],
  "x-agentmesh": { "modes": ["ask"] }
}
```

- [ ] **Step 4: Public description** — `examples/agent-b/AGENT.md` (overwrite)

```markdown
# Library Agent

This folder is a library. It owns a book catalog (`books.json`) and answers
questions about which books it holds and where they are shelved.

capabilities: book lookup, catalog search

This file is a public, human-readable description. It is shown to callers as
data and is never obeyed as a system prompt — the agent's behavior lives in
`prompts/`.
```

- [ ] **Step 5: Internal identity** — `examples/agent-b/prompts/system.md`

```markdown
You are the Library agent. You manage a book catalog for this folder.

You have one tool, `search_books`, served by your own book-search MCP server.
ALWAYS use `search_books` to look up titles or authors — never guess from
memory. The catalog is the only source of truth.

When you answer, be concise: give the matching book's title, author, and shelf
number. If `search_books` returns no matches, say plainly that the title is not
in the catalog. Do not invent books, shelves, or authors.
```

- [ ] **Step 6: Ask-mode behavior** — `examples/agent-b/prompts/ask.md`

```markdown
You are answering in read-only mode. Inspect the catalog with `search_books`
and report what you find. Do not attempt to modify any files.
```

- [ ] **Step 7: Verify the server reads this catalog**

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_books","arguments":{"query":"dune"}}}' | node examples/agent-b/tools/book-search/server.mjs`
Expected: one JSON line whose `result.content[0].text` is a JSON array containing `Dune` and `Dune Messiah`.

- [ ] **Step 8: Commit**

```bash
git add examples/agent-b/agent.json examples/agent-b/AGENT.md examples/agent-b/books.json examples/agent-b/.mcp.json examples/agent-b/prompts/
git commit -m "feat: add example agent B library definition

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Opt-in end-to-end (real `claude`) — A messages B, B answers from its tool

**Files:**
- Create: `test/agent-b-e2e.test.js`

This mirrors the existing opt-in pattern in `test/demo-e2e.test.js`: skipped unless `AGENT_MESH_E2E=1` and `claude` is on PATH. It uses the real A2A client (`src/a2a/stdio-client.js`) to message Agent B over `serve-a2a`.

- [ ] **Step 1: Write the e2e test**

Create `test/agent-b-e2e.test.js`:

```js
// Opt-in real-`claude` end-to-end: Agent B (the library) receives an A2A
// message, spawns its worker with its prompts/ identity, calls its own
// book-search MCP tool, and returns the answer in the Task.
//
// SKIPPED by default. Enable:
//   AGENT_MESH_E2E=1 npm test
// Requires `claude` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createA2AClient } from '../src/a2a/stdio-client.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentB = join(repoRoot, 'examples', 'agent-b');
const bin = join(repoRoot, 'bin', 'agent-mesh.js');

function claudeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const enabled = process.env.AGENT_MESH_E2E === '1' && claudeAvailable();

test('Agent B answers a book lookup over A2A using its own tool', { skip: !enabled }, async () => {
  const client = await createA2AClient({
    library: { root: agentB, command: 'node', args: [bin, 'serve-a2a', agentB] }
  });

  try {
    const task = await client.send('library', {
      messageId: 'm1',
      role: 'user',
      parts: [{ kind: 'text', text: "Do you have 'Dune'? Which shelf?" }],
      metadata: { 'agentmesh/mode': 'ask' }
    });

    assert.equal(task.kind, 'task');
    assert.equal(task.status.state, 'completed');
    const answer = task.status.message.parts.map((p) => p.text || '').join('\n');
    assert.match(answer, /Dune/i);
    assert.match(answer, /3/);
  } finally {
    await client.close();
  }
});
```

- [ ] **Step 2: Verify it skips cleanly in the hermetic suite**

Run: `npm test`
Expected: PASS — the e2e test reports as skipped (no `AGENT_MESH_E2E`), everything else green.

- [ ] **Step 3: Run the real end-to-end (manual, requires `claude`)**

Run: `AGENT_MESH_E2E=1 node --test test/agent-b-e2e.test.js`
Expected: PASS — the returned Task is `completed` and its message mentions `Dune` and shelf `3`. If `claude` is not installed, the test is skipped (still green).

- [ ] **Step 4: Commit**

```bash
git add test/agent-b-e2e.test.js
git commit -m "test: opt-in e2e for agent B library lookup over A2A

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `npm test` is green; the new prompts-injection, `ask`-grant, `do` default-deny, and `searchBooks` tests pass; existing tests unchanged in behavior.
- Boundary 4 holds in code: `ask` grants the agent's declared own-tools; `do` grants none.
- `examples/agent-b/` is a complete library agent: public `agent.json`/`AGENT.md`, internal `prompts/`, own `.mcp.json` tool declaration, `books.json` catalog, and the book-search server.
- With real `claude`, `AGENT_MESH_E2E=1 node --test test/agent-b-e2e.test.js` shows B answering "Dune → shelf 3" — proving B is a self-contained agent that uses its own granted MCP tool with its own identity.

## Follow-up (next increment, not this plan)

- Agent A: `examples/agent-a/` with `prompts/system.md` + `prompts/delegate.md` (caller discipline) and `registry.json` pointing at B; `scripts/library-demo.mjs` runner.
- **Boundary 5 enforcement (`do`-mode):** make the path-guard / runner deny structured writes into protected config (`prompts/`, `agent.json`, `.mcp.json`, `registry.json`, `tools/`) for delegated `do` tasks, allowing `state/`, `logs/`, and task-owned paths. Not reachable in this `ask`-only increment, but required before any `do` task runs against an agent whose identity now lives in `prompts/`.
- PROJECT.md: write in the agent anatomy, the **five** boundaries, the refined AGENT.md invariant, the declarations-are-not-grants model, and the tool-MCP trust boundary.
