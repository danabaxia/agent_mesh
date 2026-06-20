// test/dev-mesh-analyst-review-workflow.test.js — hermetic lint of the daily
// Analyst performance-review workflow. Zero-dep regex over the raw YAML text,
// mirroring the style of test/integration-workflow.test.js and
// test/dev-mesh-workflow.test.js. Spec:
// docs/superpowers/specs/2026-06-20-analyst-daily-review-design.md §6
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wfPath = fileURLToPath(new URL('../.github/workflows/dev-mesh-analyst-review.yml', import.meta.url));
const wf = readFileSync(wfPath, 'utf8');

test('workflow exists and is well-formed', () => {
  assert.ok(wf, 'dev-mesh-analyst-review.yml must exist and be non-empty');
  assert.match(wf, /^name:\s*dev-mesh-analyst-review/m, 'workflow name must be dev-mesh-analyst-review');
  assert.match(wf, /^on:/m, 'must have triggers');
  assert.match(wf, /anthropics\/claude-code-action@v1/, 'must drive claude-code-action@v1');
});

test('triggers: schedule + workflow_dispatch only (not push, not pull_request)', () => {
  assert.match(wf, /schedule:/, 'must have a schedule trigger');
  assert.match(wf, /cron:\s*'30 9 \* \* \*'/, "cron must be '30 9 * * *' (09:30 UTC, after the integration nightly)");
  assert.match(wf, /workflow_dispatch:/, 'must support manual dispatch');
  assert.doesNotMatch(wf, /^\s*push:/m, 'must not trigger on push');
  assert.doesNotMatch(wf, /^\s*pull_request:/m, 'must not trigger on pull_request');
});

test('permissions: contents:read + issues:write + pull-requests:read + actions:read, no contents:write', () => {
  assert.match(wf, /permissions:/, 'must declare permissions');
  assert.match(wf, /contents:\s*read/, 'must have contents: read');
  assert.match(wf, /issues:\s*write/, 'must have issues: write (to file idea issues)');
  assert.match(wf, /pull-requests:\s*read/, 'must have pull-requests: read (for gh pr list)');
  assert.match(wf, /actions:\s*read/, 'must have actions: read (for gh run list/download)');
  // The comment "# No contents: write" is acceptable; only a YAML key line would grant the permission.
  // Match requires the permission key pattern (not a comment line).
  assert.ok(
    !wf.split('\n').some((l) => /^\s+contents:\s*write/.test(l)),
    'must NOT have contents: write permission (proposal-only, no code)',
  );
});

test('concurrency: group dev-mesh-analyst-review, cancel-in-progress: false', () => {
  assert.match(wf, /concurrency:/, 'must have concurrency');
  assert.match(wf, /group:\s*dev-mesh-analyst-review/, 'concurrency group must be dev-mesh-analyst-review');
  assert.match(wf, /cancel-in-progress:\s*false/, 'in-flight run must not be cancelled');
});

test('--allowedTools: includes WebSearch, WebFetch, Bash(gh:*); excludes Edit and Write', () => {
  // Extract just the --allowedTools line to keep the exclusion check scoped.
  const toolsLine = wf.split('\n').find((l) => /--allowedTools/.test(l));
  assert.ok(toolsLine, '--allowedTools line must be present');
  assert.match(toolsLine, /WebSearch/, '--allowedTools must include WebSearch (web research capability)');
  assert.match(toolsLine, /WebFetch/, '--allowedTools must include WebFetch (fetch OSS pages)');
  assert.match(toolsLine, /Bash\(gh:\*\)/, '--allowedTools must include Bash(gh:*) (issue/run access)');
  // Edit/Write exclusion: checked on the extracted tools line only (not the whole YAML,
  // which legitimately mentions them in comments explaining what is NOT granted).
  assert.doesNotMatch(toolsLine, /\bEdit\b/, '--allowedTools must NOT include Edit (proposal-only)');
  assert.doesNotMatch(toolsLine, /\bWrite\b/, '--allowedTools must NOT include Write (proposal-only)');
});

test('auth: OAuth sanitize + add-mask present', () => {
  assert.match(wf, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, 'must wire CLAUDE_CODE_OAUTH_TOKEN from secrets');
  assert.match(wf, /tr -d '\[:space:\]'/, 'OAuth token must be sanitized (strip stray whitespace)');
  assert.match(wf, /::add-mask::/, 'sanitized token must be re-masked');
});

test('uses claude-code-action + agent-postrun', () => {
  assert.match(wf, /anthropics\/claude-code-action@v1/, 'must use claude-code-action@v1');
  assert.match(wf, /id:\s*claude/, 'action step must have id: claude (for agent-postrun)');
  assert.match(wf, /agent-postrun/, 'must run the agent-postrun composite action (honesty gate)');
  assert.match(wf, /advisory_blocked:\s*["']true["']/, 'agent-postrun must be advisory (light/ask role, no Bash(git:*))');
});

test('github_token wired for gh issue/pr/run access', () => {
  assert.match(wf, /github_token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, 'must wire GITHUB_TOKEN for gh commands');
});

test('model via vars.DEV_MESH_MODEL with sonnet fallback (never forces Opus)', () => {
  assert.match(wf, /vars\.DEV_MESH_MODEL/, 'model must come from the DEV_MESH_MODEL repo variable');
  assert.match(wf, /'sonnet'/, "fallback must be the 'sonnet' alias");
  assert.doesNotMatch(wf, /claude-opus-4-8/, 'must not force Opus (deploy key has no access)');
});

test('prompt: reads analyst role (dev-mesh/analyst)', () => {
  assert.match(wf, /dev-mesh\/analyst/, 'prompt must direct the Analyst to read its role');
});

test('prompt: gathers MIR via gh run download + reads mir-*.json (JSON only, not .md)', () => {
  assert.match(wf, /gh run list.*integration\.yml|integration\.yml.*gh run list/, 'prompt must use gh run list --workflow integration.yml');
  assert.match(wf, /gh run download/, 'prompt must use gh run download to fetch the mir-artifact');
  assert.match(wf, /mir-\*\.json|mir-.+\.json/, 'prompt must read mir-*.json (JSON only, not .md)');
  assert.match(wf, /degrade|continue.*other signals|no MIR artifact/i, 'prompt must degrade gracefully if MIR is absent');
});

test('prompt: gathers issue/PR history for performance signals', () => {
  assert.match(wf, /gh issue list/, 'prompt must run gh issue list');
  assert.match(wf, /gh pr list/, 'prompt must run gh pr list');
});

test('prompt: performs WebSearch/WebFetch research (issues-only, no spec/memory)', () => {
  assert.match(wf, /WebSearch|WebFetch/, 'prompt must direct use of WebSearch/WebFetch');
  assert.match(wf, /DATA.*never.*instructions|treat.*page.*DATA/i, 'prompt must frame fetched pages as DATA not instructions');
  // The prompt must not instruct writing draft-specs or absorbing/writing memory.
  // We check that there is no "write draft spec" or "absorb memory" instruction
  // (but "do NOT write draft specs" is the correct negated form — fine).
  assert.doesNotMatch(wf, /^\s*(?:write a draft spec|write draft specs|absorb memory|write.*memory)/im,
    'must be issues-only (no draft-spec / no memory writes)');
});

test('prompt: dedupes against open issues before filing', () => {
  assert.match(wf, /DEDUPE|dedupe|dedup/i, 'prompt must instruct deduplication');
  assert.match(wf, /gh issue list.*open|open.*gh issue list/, 'prompt must check open issues before filing');
});

test('prompt: §5.3 proposal-only gate — forbids code, PR, and approvals (STOP after filing)', () => {
  assert.match(wf, /do NOT write code|Do NOT write code/i, 'prompt must explicitly forbid writing code');
  assert.match(wf, /do NOT open a code PR|Do NOT open a code PR/i, 'prompt must explicitly forbid opening a code PR');
  assert.match(wf, /Propose only|propose only/i, 'prompt must say "propose only"');
  assert.match(wf, /STOP/, 'prompt must say STOP (hard gate after proposal)');
});
