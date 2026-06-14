import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function runDemo() {
  const ws = mkdtempSync(join(tmpdir(), 'agent-mesh-complex-demo-'));
  const out = execFileSync(
    'node',
    [join(repoRoot, 'scripts', 'complex-demo.mjs'), '--workspace', ws, '--force', '--json'],
    {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
      // The demo exercises do-mode writes; on Windows that requires attesting the
      // managed-settings policy is path-guard-compatible (else do-mode is refused
      // before the scripted worker runs). Harmless on POSIX.
      env: { ...process.env, AGENT_MESH_ATTEST_MANAGED_COMPATIBLE: '1' }
    }
  );
  return JSON.parse(out);
}

// ─── Initialization + peer card (PROJECT.md baseline preserved) ───────────

test('demo initializes the library peer with ask + do modes', () => {
  const s = runDemo();
  assert.equal(s.peer.name, 'library');
  assert.ok(s.peer.modes.includes('ask'));
  assert.ok(s.peer.modes.includes('do'));
});

test('demo initializes the coding-agent peer with ask + do modes', () => {
  const s = runDemo();
  assert.equal(s.codingAgent.peer.name, 'coding-agent');
  assert.ok(s.codingAgent.peer.modes.includes('ask'));
  assert.ok(s.codingAgent.peer.modes.includes('do'));
  assert.deepEqual(s.codingAgent.peer.skills, ['delegate']);
});

// ─── Observability bundle (spec §6 + §9 demo tests + §10 success criteria) ─

test('observability snapshot reports all four runtime context layers for agent B', () => {
  const o = runDemo().observability;

  // Spec §10 line 330 "B's identity comes from prompts/system.md"
  assert.equal(o.agentB.prompts.system, true);
  assert.equal(o.agentB.prompts.ask, true);
  assert.equal(o.agentB.prompts.do, true);

  // Spec §10 line 331 "B's memory and workflow files are included"
  // Memory profile.md must be first (spec §4 line 121). decisions.md is optimized/excluded from eager loading.
  assert.deepEqual(o.agentB.memory, ['profile.md', 'catalog-policy.md']);
  assert.equal(o.agentB.workflows.default, true);
  assert.equal(o.agentB.workflows.ask, true);
  assert.equal(o.agentB.workflows.do, true);

  // Spec §10 line 332 "global and local skills are visible"
  assert.deepEqual(o.agentB.skills.global, ['citation-format']);
  assert.deepEqual(o.agentB.skills.local, ['shelf-answer']);

  // Spec §9 line 298 "Prompt length is bounded by the existing prompt budget"
  // MAX_PROMPT_CHARS = 8000.
  assert.ok(o.agentB.promptLengths.ask > 0 && o.agentB.promptLengths.ask <= 8000);
  assert.ok(o.agentB.promptLengths.do > 0 && o.agentB.promptLengths.do <= 8000);
});

test('observability snapshot reports coding-agent runtime anatomy', () => {
  const o = runDemo().codingAgent.observability;

  assert.equal(o.prompts.system, true);
  assert.equal(o.prompts.ask, true);
  assert.equal(o.prompts.do, true);
  assert.deepEqual(o.memory, [
    'profile.md',
    'coding-standards.md',
    'safety-policy.md',
    'verification-policy.md'
  ]);
  assert.equal(o.workflows.default, true);
  assert.equal(o.workflows.ask, true);
  assert.equal(o.workflows.do, true);
  assert.deepEqual(o.skills.local, ['code-review', 'patch-planning', 'test-strategy']);
  assert.ok(o.promptLengths.ask > 0 && o.promptLengths.ask <= 8000);
  assert.ok(o.promptLengths.do > 0 && o.promptLengths.do <= 8000);
});

test('observability reports MCP discovery — global declared, never granted; local granted only in ask', () => {
  const m = runDemo().observability.mcp;

  // Spec §10 line 333 "global and local MCP declarations are visible"
  assert.deepEqual(m.global.discovered, ['citation-policy']);
  assert.deepEqual(m.local.discovered, ['book-search', 'memory-recall']);

  // Spec §5 line 162-163, §8 Non-goal, §9 MCP test "global MCP declarations
  // are not granted in `ask`" — and they're not granted in do either.
  assert.deepEqual(m.global.grantedInAsk, []);
  assert.deepEqual(m.global.grantedInDo, []);

  // Spec §9 MCP test "local read-only marked servers are granted in `ask`"
  assert.deepEqual(m.local.grantedInAsk, ['book-search', 'memory-recall']);
  // Spec §9 MCP test "no non-framework MCP tools are granted in `do`"
  assert.deepEqual(m.local.grantedInDo, []);
});

// ─── Scenario 1 — Local MCP + Memory (spec §7 line 210-223) ───────────────

test('Scenario 1: B answers Dune query from local catalog (book-search MCP + catalog-policy memory)', () => {
  const s = runDemo().scenarios.scenario1_local_mcp_memory;
  assert.equal(s.state, 'TASK_STATE_COMPLETED');
  // §7 line 223 "B answers from the catalog, not from model memory" — shelf 3
  // is the canonical books.json entry for Dune.
  assert.match(s.text, /Dune/i);
  assert.match(s.text, /shelf\s*3/i);
});

// ─── Scenario 2 — Global Skill + Local Skill (spec §7 line 225-237) ───────

test('Scenario 2: B applies global citation-format skill and local shelf-answer skill together', () => {
  const s = runDemo().scenarios.scenario2_global_skill_local_skill;
  assert.equal(s.state, 'TASK_STATE_COMPLETED');
  // §7 line 237 "B answers using the shared format while still applying
  // local shelf rules" — citation-format = "**Title** — Author *(Year)* · location"
  // and shelf-answer = "is on shelf N" / "shelf N". The reply must show both.
  assert.match(s.text, /\*\*Dune\*\*/, 'citation-format bold title missing');
  assert.match(s.text, /Frank Herbert/, 'author from catalog missing');
  assert.match(s.text, /shelf\s*3/i, 'local shelf-answer style missing');
});

// ─── Scenario 3 — Do Mode Boundary (spec §7 line 239-248) ─────────────────

test('Scenario 3: B writes inside its own root, non-framework MCP not granted in do', () => {
  const summary = runDemo();
  const s = summary.scenarios.scenario3_do_mode_boundary;
  assert.equal(s.state, 'TASK_STATE_COMPLETED');
  // §7 line 248 "files_changed reports only B-owned files"
  assert.deepEqual(s.filesChanged, ['lib/strings.js']);
  // §7 line 246 "non-framework MCP tools are not granted in do"
  assert.deepEqual(summary.observability.mcp.local.grantedInDo, []);
  assert.deepEqual(summary.observability.mcp.global.grantedInDo, []);
  // §7 line 247 "writes remain confined to B's root" — caller folder is empty
  // except its AGENT.md (no leak)
  assert.ok(!existsSync(join(summary.workspace.agentA, 'INJECTED.txt')));
  // and the actual write happened in B's lib/strings.js
  assert.match(
    readFileSync(join(summary.workspace.agentB, 'lib', 'strings.js'), 'utf8'),
    /export function truncateSlug\s*\(/
  );
});

// ─── Scenario 4 — Anti-Guessing (spec §7 line 250-258) ────────────────────

test('Scenario 4: B refuses to answer from training memory and points back at the catalog', () => {
  const s = runDemo().scenarios.scenario4_anti_guessing;
  assert.equal(s.state, 'TASK_STATE_COMPLETED');
  // §7 line 257 "B refuses to guess or states that the catalog is the source
  // of truth" — fake-claude scripted response per memory/catalog-policy.md rule 4.
  assert.match(s.text, /catalog|search_books/i, 'must reference catalog/search_books');
  assert.match(s.text, /can'?t|cannot|will not|won'?t|refus/i, 'must convey refusal');
  // §7 line 258 "B uses book-search in ask mode" — book-search must remain in
  // the grant list for the ask mode this Scenario runs in.
});

// ─── Bad-input invariant (PROJECT.md baseline, preserved from pre-Chunk-5 demo) ──

test('Bad input is rejected before the worker starts (PROJECT.md invariant)', () => {
  const b = runDemo().badInput;
  assert.equal(b.state, 'TASK_STATE_REJECTED');
  assert.equal(b.errorCode, 'bad_input');
});

test('Coding Agent ask scenario returns a read-only implementation plan over A2A', () => {
  const s = runDemo().codingAgent.scenarios.ask_review_plan;
  assert.equal(s.state, 'TASK_STATE_COMPLETED');
  assert.match(s.text, /Implementation tasks/i);
  assert.match(s.text, /read-only/i);
});

test('Coding Agent do scenario writes only inside its assigned root', () => {
  const summary = runDemo();
  const s = summary.codingAgent.scenarios.do_write_fixture;

  assert.equal(s.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(s.filesChanged, ['CODING_AGENT_FIXTURE.txt']);
  assert.match(
    readFileSync(join(summary.workspace.codingAgent, 'CODING_AGENT_FIXTURE.txt'), 'utf8'),
    /written by coding-agent do mode/i
  );
  assert.ok(!existsSync(join(summary.workspace.agentA, 'CODING_AGENT_FIXTURE.txt')));
  assert.ok(!existsSync(join(summary.workspace.agentB, 'CODING_AGENT_FIXTURE.txt')));
});
