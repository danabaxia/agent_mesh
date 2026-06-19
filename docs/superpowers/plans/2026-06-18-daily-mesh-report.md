# Daily Mesh Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A once-a-day digest of PRs, Issues, and Tokens (local A2A daemon + GitHub-Actions CI) posted by the always-on host as a rolling pinned GitHub issue.

**Architecture:** A pure report core (`src/report/usage.js`, `aggregate.js`, `render.js`) consumes three record sets and produces a `DailyReport`, rendered to Markdown. An impure shell (`src/report/sources.js`, `scripts/daily-report.mjs`) gathers data via injected `gh`/fs deps. CI token usage is captured race-free as a per-run `upload-artifact` off the existing `assert-run-healthy` seam, then pulled and merged on the host.

**Tech Stack:** Node ≥ 20, ESM, zero deps, `node --test`. GitHub via the `gh` CLI. Scheduling via launchd (macOS) / systemd timer (Linux).

Spec: `docs/superpowers/specs/2026-06-18-daily-mesh-report-design.md`. Build order: **P1** (Tasks 1–6, local tokens + PR/Issue + post + schedule) → **P2** (Tasks 7–11, CI capture, both sources). P3 (dashboard) is out of scope for this plan.

---

## File structure

| File | Responsibility |
|---|---|
| `src/report/usage.js` (new) | Pure `extractUsage` / `emptyUsage` / `sumUsage` — normalize any envelope-or-record into one token shape |
| `src/report/aggregate.js` (new) | Pure `aggregate()` + `dayBoundsMs()` — raw records → `DailyReport` |
| `src/report/render.js` (new) | Pure `renderMarkdown` / `renderModel` / `dailyMarker` / `findDatedCommentId` |
| `src/report/sources.js` (new) | Impure shell: `readLocalLogs`, `fetchGhActivity`, `fetchCiUsage` (injected deps) |
| `scripts/daily-report.mjs` (new) | Entrypoint: wire sources → core → post; `--date/--post/--dry-run/--selftest` |
| `scripts/assert-run-healthy.mjs` (modify) | Also emit `MESH_USAGE_OUT` usage file (P2) |
| `.github/actions/agent-postrun/action.yml` (new) | Composite: health gate + upload usage artifact (P2) |
| `.github/workflows/dev-mesh-*.yml` (modify ×N) | Use the composite action (P2) |
| `scripts/dev-society-install.sh` (modify) | Add daily-report schedule unit + subcommand |
| `test/report-usage.test.js`, `report-aggregate.test.js`, `report-render.test.js`, `report-sources.test.js` (new) | Hermetic unit tests |
| `test/integration-workflow.test.js` (modify) | Assert composite-action wiring (P2) |

---

## Task 1: `extractUsage` — normalize token shapes

**Files:**
- Create: `src/report/usage.js`
- Test: `test/report-usage.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/report-usage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, emptyUsage, sumUsage } from '../src/report/usage.js';

test('extractUsage reads a RAW claude envelope (usage nested, cost/turns top-level)', () => {
  const env = {
    result: 'ok',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
    total_cost_usd: 0.42, num_turns: 7, model: 'claude-sonnet-4-6',
  };
  assert.deepEqual(extractUsage(env), {
    input: 100, output: 20, cacheRead: 5, cacheCreation: 3, costUsd: 0.42, turns: 7, model: 'claude-sonnet-4-6',
  });
});

test('extractUsage reads a LOCAL run record (cost/turns flattened inside usage)', () => {
  const rec = { usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0.01, num_turns: 2 } };
  const u = extractUsage(rec);
  assert.equal(u.input, 9);
  assert.equal(u.costUsd, 0.01);
  assert.equal(u.turns, 2);
});

test('extractUsage on missing/garbage → zeros, never throws', () => {
  assert.deepEqual(extractUsage(null), emptyUsage());
  assert.deepEqual(extractUsage({}), emptyUsage());
  assert.equal(extractUsage({ usage: null }).input, 0);
});

test('sumUsage adds fields and keeps model null', () => {
  const total = sumUsage([
    { input: 1, output: 2, cacheRead: 0, cacheCreation: 0, costUsd: 0.1, turns: 1, model: 'a' },
    { input: 3, output: 4, cacheRead: 1, cacheCreation: 0, costUsd: 0.2, turns: 2, model: 'b' },
  ]);
  assert.equal(total.input, 4);
  assert.equal(total.output, 6);
  assert.equal(total.turns, 3);
  assert.ok(Math.abs(total.costUsd - 0.3) < 1e-9);
  assert.equal(total.model, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report-usage.test.js`
Expected: FAIL — `Cannot find module '../src/report/usage.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/report/usage.js
// Pure token-usage normalizer. Accepts either a RAW claude result envelope
// (usage nested, total_cost_usd/num_turns top-level) or a LOCAL run record /
// usage block (cost/turns flattened inside `usage`). Always returns the same
// flat numeric shape; never throws.

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 0, model: null };
}

export function extractUsage(src) {
  if (!src || typeof src !== 'object') return emptyUsage();
  const u = src.usage && typeof src.usage === 'object' ? src.usage : src;
  const model = typeof src.model === 'string' ? src.model
    : (typeof u.model === 'string' ? u.model : null);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    // cost/turns may be top-level (raw envelope) or inside usage (normalized record)
    costUsd: num(src.total_cost_usd ?? u.total_cost_usd),
    turns: num(src.num_turns ?? u.num_turns),
    model,
  };
}

export function sumUsage(usages) {
  const out = emptyUsage();
  for (const u of usages) {
    out.input += num(u.input); out.output += num(u.output);
    out.cacheRead += num(u.cacheRead); out.cacheCreation += num(u.cacheCreation);
    out.costUsd += num(u.costUsd); out.turns += num(u.turns);
  }
  return out;  // model stays null on a sum (heterogeneous)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/report-usage.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/usage.js test/report-usage.test.js
git commit -m "feat(report): pure token-usage normalizer (extractUsage/sumUsage)"
```

---

## Task 2: `aggregate` — raw records → DailyReport

**Files:**
- Create: `src/report/aggregate.js`
- Test: `test/report-aggregate.test.js`

`aggregate` filters each raw list to the calendar day `date` (UTC bounds — the entrypoint chooses which date) and rolls up tokens. Input shapes:
- `prs`: `[{ number, title, author, url, createdAt, closedAt, mergedAt }]` (ISO strings or null)
- `issues`: `[{ number, title, labels:[string], url, createdAt, closedAt }]`
- `openPrs` / `openIssues`: snapshot arrays (already filtered to state=open by the source)
- `localRecords`: deduped run-log records (each has `usage`, `route`, `finished_at`/`started_at`, `state`)
- `ciRecords`: `[{ workflow, runId, ts, usage }]`

- [ ] **Step 1: Write the failing test**

```js
// test/report-aggregate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, dayBoundsMs } from '../src/report/aggregate.js';

const DATE = '2026-06-18';
const inDay = '2026-06-18T09:00:00.000Z';
const nextDay = '2026-06-19T09:00:00.000Z';

test('dayBoundsMs returns the UTC calendar day [from, to)', () => {
  const { fromMs, toMs } = dayBoundsMs(DATE);
  assert.equal(new Date(fromMs).toISOString(), '2026-06-18T00:00:00.000Z');
  assert.equal(new Date(toMs).toISOString(), '2026-06-19T00:00:00.000Z');
});

test('aggregate buckets PRs/issues by in-window timestamps', () => {
  const r = aggregate({
    date: DATE,
    prs: [
      { number: 1, title: 'a', author: 'x', url: 'u1', createdAt: inDay, mergedAt: null, closedAt: null },
      { number: 2, title: 'b', author: 'y', url: 'u2', createdAt: '2026-06-10T00:00:00Z', mergedAt: inDay, closedAt: inDay },
      { number: 3, title: 'c', author: 'z', url: 'u3', createdAt: nextDay, mergedAt: null, closedAt: null },
    ],
    openPrs: [{ number: 1 }, { number: 9 }],
    issues: [
      { number: 5, title: 'i', labels: ['approved'], url: 'iu5', createdAt: inDay, closedAt: null },
      { number: 6, title: 'j', labels: [], url: 'iu6', createdAt: '2026-06-01T00:00:00Z', closedAt: inDay },
    ],
    openIssues: [{ number: 5, labels: ['approved'] }, { number: 7, labels: ['blocked', 'approved'] }],
    localRecords: [], ciRecords: [],
  });
  assert.deepEqual(r.prs.opened.map((p) => p.number), [1]);
  assert.deepEqual(r.prs.merged.map((p) => p.number), [2]);
  assert.equal(r.prs.openNow, 2);
  assert.deepEqual(r.issues.opened.map((i) => i.number), [5]);
  assert.deepEqual(r.issues.closed.map((i) => i.number), [6]);
  assert.deepEqual(r.issues.openByLabel, { approved: 2, blocked: 1 });
});

test('aggregate sums local tokens by route and CI tokens by workflow', () => {
  const r = aggregate({
    date: DATE,
    prs: [], openPrs: [], issues: [], openIssues: [],
    localRecords: [
      { route: 'coder', finished_at: inDay, state: 'done', usage: { input_tokens: 100, output_tokens: 10, total_cost_usd: 0.5, num_turns: 3 } },
      { route: 'coder', finished_at: inDay, state: 'done', usage: { input_tokens: 50, output_tokens: 5, total_cost_usd: 0.25, num_turns: 1 } },
      { route: 'reviewer', finished_at: inDay, state: 'done', usage: { input_tokens: 20, output_tokens: 2, total_cost_usd: 0.1, num_turns: 1 } },
      { route: 'coder', finished_at: nextDay, state: 'done', usage: { input_tokens: 999, output_tokens: 999 } }, // out of window
    ],
    ciRecords: [
      { workflow: 'dev-mesh-review', runId: '1', ts: inDay, usage: { usage: { input_tokens: 1000, output_tokens: 100 }, num_turns: 9 } },
      { workflow: 'dev-mesh-triage', runId: '2', ts: inDay, usage: { usage: { input_tokens: 500, output_tokens: 50 }, num_turns: 4 } },
    ],
  });
  assert.equal(r.tokens.local.input, 170);
  assert.equal(r.tokens.local.byRoute.coder.input, 150);
  assert.equal(r.tokens.local.runs, 3);
  assert.equal(r.tokens.ci.input, 1500);
  assert.equal(r.tokens.ci.costUsd, 0);
  assert.equal(r.tokens.ci.byWorkflow['dev-mesh-review'].input, 1000);
  assert.equal(r.tokens.total.input, 1670);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report-aggregate.test.js`
Expected: FAIL — `Cannot find module '../src/report/aggregate.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/report/aggregate.js
// Pure reducer: raw record sets → DailyReport. No I/O, no Date.now() —
// `date` (YYYY-MM-DD) fixes the UTC window; the impure entrypoint picks it.
import { extractUsage, sumUsage, emptyUsage } from './usage.js';

export function dayBoundsMs(date) {
  const fromMs = Date.parse(`${date}T00:00:00.000Z`);
  return { fromMs, toMs: fromMs + 24 * 60 * 60 * 1000 };
}

const inWin = (iso, fromMs, toMs) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= fromMs && t < toMs;
};

function rollup(records, keyOf, tsOf, fromMs, toMs) {
  const byKey = {};
  const all = [];
  let runs = 0;
  for (const rec of records) {
    if (!inWin(tsOf(rec), fromMs, toMs)) continue;
    runs++;
    const u = extractUsage(rec.usage ?? rec);
    all.push(u);
    const k = keyOf(rec) || 'unknown';
    byKey[k] = byKey[k] ? sumUsage([byKey[k], u]) : u;
  }
  return { ...sumUsage(all), runs, byKey };
}

export function aggregate({ date, prs = [], openPrs = [], issues = [], openIssues = [], localRecords = [], ciRecords = [] }) {
  const { fromMs, toMs } = dayBoundsMs(date);
  const slimPr = (p) => ({ number: p.number, title: p.title, author: p.author, url: p.url });
  const slimIssue = (i) => ({ number: i.number, title: i.title, labels: i.labels || [], url: i.url });

  const openByLabel = {};
  for (const i of openIssues) for (const l of (i.labels || [])) openByLabel[l] = (openByLabel[l] || 0) + 1;

  const local = rollup(localRecords, (r) => r.route, (r) => r.finished_at || r.started_at, fromMs, toMs);
  const ci = rollup(ciRecords, (r) => r.workflow, (r) => r.ts, fromMs, toMs);
  ci.costUsd = 0;  // subscription auth reports $0; never claim CI dollars
  ci.uncaptured = ciRecords.filter((r) => inWin(r.ts, fromMs, toMs) && r.uncaptured).length;

  const reshape = (g) => { const { byKey, ...rest } = g; return rest; };
  const total = sumUsage([reshape(local), reshape(ci)]);

  return {
    date,
    window: { fromISO: new Date(fromMs).toISOString(), toISO: new Date(toMs).toISOString() },
    prs: {
      opened: prs.filter((p) => inWin(p.createdAt, fromMs, toMs)).map(slimPr),
      merged: prs.filter((p) => inWin(p.mergedAt, fromMs, toMs)).map(slimPr),
      closed: prs.filter((p) => !p.mergedAt && inWin(p.closedAt, fromMs, toMs)).map(slimPr),
      openNow: openPrs.length,
    },
    issues: {
      opened: issues.filter((i) => inWin(i.createdAt, fromMs, toMs)).map(slimIssue),
      closed: issues.filter((i) => inWin(i.closedAt, fromMs, toMs)).map(slimIssue),
      openByLabel,
    },
    tokens: {
      local: { ...reshape(local), byRoute: local.byKey },
      ci: { ...reshape(ci), byWorkflow: ci.byKey },
      total: reshape(total),
    },
  };
}
```

Note: `rollup` returns `{...usage, runs, byKey}`; `reshape` strips `byKey` before summing/exposing, and the caller renames `byKey`→`byRoute`/`byWorkflow`. `extractUsage(rec.usage ?? rec)` handles both local records (nested `usage`) and CI records (whose `usage` is a raw envelope).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/report-aggregate.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/aggregate.js test/report-aggregate.test.js
git commit -m "feat(report): pure aggregate() → DailyReport with windowed token rollup"
```

---

## Task 3: `render` — Markdown + comment-marker helpers

**Files:**
- Create: `src/report/render.js`
- Test: `test/report-render.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/report-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderModel, dailyMarker, findDatedCommentId } from '../src/report/render.js';

const REPORT = {
  date: '2026-06-18',
  window: { fromISO: '2026-06-18T00:00:00.000Z', toISO: '2026-06-19T00:00:00.000Z' },
  prs: { opened: [{ number: 1, title: 'a', url: 'u' }], merged: [], closed: [], openNow: 7 },
  issues: { opened: [], closed: [], openByLabel: { approved: 3, blocked: 1 } },
  tokens: {
    local: { input: 170, output: 17, cacheRead: 0, cacheCreation: 0, costUsd: 0.85, turns: 5, runs: 3, byRoute: {} },
    ci: { input: 1500, output: 150, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 13, runs: 2, uncaptured: 1, byWorkflow: {} },
    total: { input: 1670, output: 167, cacheRead: 0, cacheCreation: 0, costUsd: 0.85, turns: 18 },
  },
};

test('dailyMarker is a stable HTML comment keyed by date', () => {
  assert.equal(dailyMarker('2026-06-18'), '<!-- daily-report:2026-06-18 -->');
});

test('renderMarkdown embeds the marker, the date, and the $0 footnote', () => {
  const md = renderMarkdown(REPORT);
  assert.ok(md.includes('<!-- daily-report:2026-06-18 -->'));
  assert.ok(md.includes('Daily Mesh Report — 2026-06-18'));
  assert.ok(md.includes('open now 7'));
  assert.ok(md.includes('approved 3'));
  assert.ok(/subscription auth reports \$0/i.test(md));
  assert.ok(md.includes('1 uncaptured'));
});

test('findDatedCommentId returns the id of the comment carrying the date marker', () => {
  const comments = [
    { id: 11, body: 'unrelated' },
    { id: 22, body: `prefix\n${dailyMarker('2026-06-18')}\nstuff` },
  ];
  assert.equal(findDatedCommentId(comments, '2026-06-18'), 22);
  assert.equal(findDatedCommentId(comments, '2026-06-17'), null);
});

test('renderModel returns a JSON-able object (no markdown)', () => {
  const m = renderModel(REPORT);
  assert.equal(m.date, '2026-06-18');
  assert.equal(m.tokens.total.input, 1670);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report-render.test.js`
Expected: FAIL — `Cannot find module '../src/report/render.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/report/render.js
// Pure renderers for a DailyReport. renderMarkdown → the GitHub issue comment
// body (carries a date marker for idempotent upsert); renderModel → a plain
// object for the (future) dashboard route.

export function dailyMarker(date) { return `<!-- daily-report:${date} -->`; }

export function findDatedCommentId(comments, date) {
  const marker = dailyMarker(date);
  const hit = (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
  return hit ? hit.id : null;
}

const fmt = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
};
const usd = (n) => `$${n.toFixed(2)}`;
const prLine = (p) => `  #${p.number} ${p.title}`;

export function renderMarkdown(r) {
  const t = r.tokens;
  const lines = [];
  lines.push(dailyMarker(r.date));
  lines.push(`### 📊 Daily Mesh Report — ${r.date}`);
  lines.push('');
  lines.push(`**PRs** · opened ${r.prs.opened.length} · merged ${r.prs.merged.length} · closed ${r.prs.closed.length} · open now ${r.prs.openNow}`);
  for (const p of r.prs.opened.slice(0, 10)) lines.push(prLine(p));
  lines.push('');
  const labels = Object.entries(r.issues.openByLabel).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
  lines.push(`**Issues** · opened ${r.issues.opened.length} · closed ${r.issues.closed.length} · open: ${labels}`);
  lines.push('');
  lines.push('**Tokens**');
  lines.push('| stream | input | output | turns | cost |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| local | ${fmt(t.local.input)} | ${fmt(t.local.output)} | ${t.local.turns} | ${usd(t.local.costUsd)} (${t.local.runs} runs) |`);
  const unc = t.ci.uncaptured ? `, ${t.ci.uncaptured} uncaptured` : '';
  lines.push(`| ci | ${fmt(t.ci.input)} | ${fmt(t.ci.output)} | ${t.ci.turns} | $0* (${t.ci.runs} runs${unc}) |`);
  lines.push(`| total | ${fmt(t.total.input)} | ${fmt(t.total.output)} | ${t.total.turns} | |`);
  lines.push('');
  lines.push('_*subscription auth reports $0_');
  return lines.join('\n');
}

export function renderModel(r) { return JSON.parse(JSON.stringify(r)); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/report-render.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/render.js test/report-render.test.js
git commit -m "feat(report): markdown renderer + dated-comment upsert helpers"
```

---

## Task 4: `sources` (local + gh) with injected deps

**Files:**
- Create: `src/report/sources.js`
- Test: `test/report-sources.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/report-sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLocalLogs, fetchGhActivity } from '../src/report/sources.js';

test('readLocalLogs reads + dedupes the date-grouped delegate log', async () => {
  const calls = [];
  const recs = await readLocalLogs({
    logDir: '/x/.agent-mesh/logs',
    date: '2026-06-18',
    readRecords: async (p) => { calls.push(p); return [
      { id: 'a', route: 'coder', usage: { input_tokens: 1 } },
      { id: 'a', route: 'coder', usage: { input_tokens: 5 } }, // final wins
    ]; },
  });
  assert.equal(calls[0], '/x/.agent-mesh/logs/delegate-2026-06-18.jsonl');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].usage.input_tokens, 5);
});

test('fetchGhActivity shells gh for prs/issues and parses JSON', async () => {
  const seen = [];
  const gh = async (args) => {
    seen.push(args.join(' '));
    if (args[0] === 'pr' && args.includes('--state') && args[args.indexOf('--state') + 1] === 'open')
      return JSON.stringify([{ number: 9 }]);
    if (args[0] === 'pr') return JSON.stringify([{ number: 1, title: 't', author: { login: 'me' }, url: 'u', createdAt: 'x', mergedAt: null, closedAt: null }]);
    if (args[0] === 'issue' && args.includes('--state') && args[args.indexOf('--state') + 1] === 'open')
      return JSON.stringify([{ number: 7, labels: [{ name: 'blocked' }] }]);
    return JSON.stringify([{ number: 5, title: 'i', labels: [{ name: 'approved' }], url: 'iu', createdAt: 'x', closedAt: null }]);
  };
  const a = await fetchGhActivity({ gh, repo: 'o/r' });
  assert.equal(a.prs[0].author, 'me');        // author.login flattened
  assert.deepEqual(a.openPrs, [{ number: 9 }]);
  assert.deepEqual(a.issues[0].labels, ['approved']); // label objects flattened to names
  assert.deepEqual(a.openIssues[0].labels, ['blocked']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report-sources.test.js`
Expected: FAIL — `Cannot find module '../src/report/sources.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/report/sources.js
// Impure data shell. Every effectful dependency (gh runner, record reader,
// fs) is injected so the core stays hermetically testable.
import { join } from 'node:path';
import { readRunLogRecords, dedupeRunRecords } from '../log.js';

export async function readLocalLogs({ logDir, date, prefix = 'delegate', readRecords = readRunLogRecords }) {
  const path = join(logDir, `${prefix}-${date}.jsonl`);
  const records = await readRecords(path);
  return dedupeRunRecords(records);
}

const PR_FIELDS = 'number,title,author,url,createdAt,closedAt,mergedAt';
const ISSUE_FIELDS = 'number,title,labels,url,createdAt,closedAt';
const names = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l.name));

export async function fetchGhActivity({ gh, repo, lookbackDays = 3 }) {
  const search = `--search`;
  const recentPrs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', PR_FIELDS]));
  const openPrs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number']));
  const recentIssues = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '100', '--json', ISSUE_FIELDS]));
  const openIssues = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '300', '--json', 'number,labels']));
  void search; void lookbackDays;
  return {
    prs: recentPrs.map((p) => ({ ...p, author: p.author && p.author.login })),
    openPrs,
    issues: recentIssues.map((i) => ({ ...i, labels: names(i.labels) })),
    openIssues: openIssues.map((i) => ({ ...i, labels: names(i.labels) })),
  };
}
```

Note: `aggregate` does the date-window filtering, so the sources fetch a generous recent window (`--state all --limit 100`) and let the core bucket it. `fetchCiUsage` is added in Task 10.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/report-sources.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/sources.js test/report-sources.test.js
git commit -m "feat(report): impure sources shell (local logs + gh activity), injected deps"
```

---

## Task 5: `daily-report.mjs` entrypoint (P1: local + gh + post)

**Files:**
- Create: `scripts/daily-report.mjs`
- Test: covered by `--selftest` (run in Step 4) + the unit tests above.

- [ ] **Step 1: Write the entrypoint**

```js
#!/usr/bin/env node
// scripts/daily-report.mjs — the impure outer shell for the Daily Mesh Report.
// Gathers local-log tokens + gh PR/issue activity (+ CI usage in P2), aggregates
// to a DailyReport, renders Markdown, and upserts ONE rolling pinned issue's
// dated comment. The host runs this once a day (see scripts/dev-society-install.sh).
//
//   DEV_SOCIETY_REPO=owner/repo node scripts/daily-report.mjs --post
//   node scripts/daily-report.mjs --date 2026-06-18 --dry-run   # print only
//   node scripts/daily-report.mjs --selftest                    # wiring, no gh
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../src/report/aggregate.js';
import { renderMarkdown, dailyMarker, findDatedCommentId } from '../src/report/render.js';
import { readLocalLogs, fetchGhActivity } from '../src/report/sources.js';
import { fetchCiUsage } from '../src/report/sources.js';   // present after Task 10; harmless import otherwise

const sh = promisify(execFile);
const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const REPO = process.env.DEV_SOCIETY_REPO || '';
const LABEL = process.env.DAILY_REPORT_LABEL || 'mesh:daily-report';
const TITLE = process.env.DAILY_REPORT_TITLE || '📊 Daily Mesh Report';
const logDir = resolve(repoRoot, process.env.AGENT_MESH_LOG_DIR || '.agent-mesh/logs');

function yesterdayUTC() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function findOrCreateIssue() {
  const found = JSON.parse(await gh(['issue', 'list', '--repo', REPO, '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1']));
  if (found.length) return found[0].number;
  // create the rolling issue once; ensure the label exists first (ignore "already exists")
  await sh('gh', ['label', 'create', LABEL, '--repo', REPO, '--color', 'BFD4F2', '--description', 'Rolling daily mesh report'], { maxBuffer: 1 << 20 }).catch(() => {});
  const out = await gh(['issue', 'create', '--repo', REPO, '--title', TITLE, '--label', LABEL, '--body', 'Rolling daily mesh report. One comment per day.']);
  const m = out.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function upsertComment(issueNumber, date, body) {
  const data = JSON.parse(await gh(['issue', 'view', String(issueNumber), '--repo', REPO, '--json', 'comments']));
  const id = findDatedCommentId((data.comments || []).map((c) => ({ id: c.url, body: c.body })), date);
  if (id) {
    // gh has no "edit comment by id" for issues; emulate by posting an updated comment
    // carrying the same marker is NOT idempotent — instead use the REST API to patch.
    const m = String(id).match(/#issuecomment-(\d+)/) || String(id).match(/(\d+)$/);
    if (m) { await gh(['api', '--method', 'PATCH', `repos/${REPO}/issues/comments/${m[1]}`, '-f', `body=${body}`]); return 'edited'; }
  }
  await gh(['issue', 'comment', String(issueNumber), '--repo', REPO, '--body', body]);
  return 'added';
}

async function main() {
  const date = opt('--date', yesterdayUTC());
  if (flag('--selftest')) {
    const report = aggregate({ date, prs: [], openPrs: [], issues: [], openIssues: [], localRecords: [], ciRecords: [] });
    process.stdout.write(renderMarkdown(report) + '\n');
    console.error(`selftest OK — date=${date} logDir=${logDir} marker=${dailyMarker(date)}`);
    return;
  }
  if (!REPO) { console.error('error: DEV_SOCIETY_REPO=owner/repo required'); process.exit(2); }

  const [localRecords, activity] = await Promise.all([
    readLocalLogs({ logDir, date }).catch((e) => { console.error('local logs failed:', e.message); return []; }),
    fetchGhActivity({ gh, repo: REPO }).catch((e) => { console.error('gh activity failed:', e.message); return { prs: [], openPrs: [], issues: [], openIssues: [] }; }),
  ]);
  const ciRecords = await fetchCiUsage({ gh, repo: REPO, date }).catch(() => []);  // empty until P2

  const report = aggregate({ date, ...activity, localRecords, ciRecords });
  const body = renderMarkdown(report);

  if (flag('--dry-run') || !flag('--post')) { process.stdout.write(body + '\n'); return; }
  const issueNumber = await findOrCreateIssue();
  const action = await upsertComment(issueNumber, date, body);
  console.error(`${action} daily report on issue #${issueNumber} for ${date}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Note the comment-upsert reality: `gh issue comment` cannot edit a specific comment, so the edit path uses `gh api PATCH repos/:repo/issues/comments/:id`. The list maps each comment to `{ id: c.url, body }` and extracts the numeric id from the comment URL (`…#issuecomment-<n>`).

- [ ] **Step 2: Add a temporary stub so the P2 import resolves now**

In `src/report/sources.js`, append a P1 stub (replaced in Task 10):

```js
// P1 stub — real implementation lands in Task 10 (P2).
export async function fetchCiUsage() { return []; }
```

- [ ] **Step 3: Run the selftest**

Run: `node scripts/daily-report.mjs --selftest`
Expected: prints an empty-but-valid report Markdown (with the marker + `$0` footnote) and `selftest OK — date=… marker=<!-- daily-report:… -->` on stderr. Exit 0.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (existing + new report tests; 0 failures).

- [ ] **Step 5: Commit**

```bash
git add scripts/daily-report.mjs src/report/sources.js
git commit -m "feat(report): daily-report entrypoint — local+gh aggregate, rolling-issue upsert"
```

---

## Task 6: Schedule the report (extend the installer)

**Files:**
- Modify: `scripts/dev-society-install.sh`

- [ ] **Step 1: Add a macOS report LaunchAgent + Linux timer, wired to a new subcommand**

In `scripts/dev-society-install.sh`, add a report label near the top:

```bash
REPORT_LABEL="com.danabaxia.agent-mesh.dev-society-report"   # daily digest (calendar-scheduled)
REPORT_SERVICE="dev-society-report"
REPORT_SCRIPT="$REPO_ROOT/scripts/daily-report.mjs"
REPORT_HOUR="${DAILY_REPORT_HOUR:-8}"
REPORT_OUT="$LOG_DIR/daily-report.out.log"
```

Add macOS install (StartCalendarInterval, no KeepAlive):

```bash
macos_install_report() {
  preflight
  local plist="$HOME/Library/LaunchAgents/$REPORT_LABEL.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$REPORT_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$NODE_BIN</string><string>$REPORT_SCRIPT</string><string>--post</string></array>
    <key>WorkingDirectory</key><string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>$HOME</string>
        <key>PATH</key><string>$RUN_PATH</string>
        <key>DEV_SOCIETY_REPO</key><string>$DEV_SOCIETY_REPO</string>
$( [ -n "$CLAUDE_BIN" ] && printf '        <key>AGENT_MESH_CLAUDE</key><string>%s</string>\n' "$CLAUDE_BIN" )
    </dict>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>$REPORT_HOUR</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>$REPORT_OUT</string>
    <key>StandardErrorPath</key><string>$REPORT_OUT</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$REPORT_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed daily-report LaunchAgent ($REPORT_HOUR:00 local): $plist"
}
```

Add Linux install (service + timer):

```bash
linux_install_report() {
  preflight; need systemctl
  local svc="$HOME/.config/systemd/user/$REPORT_SERVICE.service"
  local tmr="$HOME/.config/systemd/user/$REPORT_SERVICE.timer"
  mkdir -p "$(dirname "$svc")"
  cat > "$svc" <<UNIT
[Unit]
Description=Daily Mesh Report
[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
Environment=HOME=$HOME
Environment=PATH=$RUN_PATH
Environment=DEV_SOCIETY_REPO=$DEV_SOCIETY_REPO
ExecStart=$NODE_BIN $REPORT_SCRIPT --post
StandardOutput=append:$REPORT_OUT
StandardError=append:$REPORT_OUT
UNIT
  cat > "$tmr" <<UNIT
[Unit]
Description=Run the Daily Mesh Report at ${REPORT_HOUR}:00
[Timer]
OnCalendar=*-*-* ${REPORT_HOUR}:00:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$REPORT_SERVICE.timer"
  echo "installed daily-report timer (${REPORT_HOUR}:00): $tmr"
}
```

- [ ] **Step 2: Dispatch the new subcommand**

In the `case "$CMD"` block, add `install-report`:

```bash
  install-report) "${PFX}_install_report" ;;
```

And in the default `install` case, also call the report installer after the daemon one:

```bash
  install)   "${PFX}_install"; "${PFX}_install_report" ;;
```

- [ ] **Step 3: Syntax-check**

Run: `bash -n scripts/dev-society-install.sh && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-society-install.sh
git commit -m "feat(report): schedule the daily report (launchd StartCalendarInterval / systemd timer)"
```

---

> **End of P1.** The host now posts a daily local-tokens + PR/Issue digest. Tasks 7–11 add CI token capture (the both-sources milestone).

---

## Task 7: Emit a usage file from `assert-run-healthy`

**Files:**
- Create: `src/report/usage-record.js`
- Modify: `scripts/assert-run-healthy.mjs`
- Test: `test/report-usage-record.test.js`

- [ ] **Step 1: Write the failing test for the pure record builder**

```js
// test/report-usage-record.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageRecord } from '../src/report/usage-record.js';

test('buildUsageRecord shapes a CI usage record from an envelope + env', () => {
  const env = { GITHUB_WORKFLOW: 'dev-mesh-review', GITHUB_RUN_ID: '123', GITHUB_REF: 'refs/pull/9/merge' };
  const rec = buildUsageRecord(
    { result: 'ok', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.1, num_turns: 3 },
    env,
    () => '2026-06-18T09:00:00.000Z',
  );
  assert.equal(rec.workflow, 'dev-mesh-review');
  assert.equal(rec.runId, '123');
  assert.equal(rec.ts, '2026-06-18T09:00:00.000Z');
  assert.equal(rec.usage.input_tokens, 10);
  assert.equal(rec.usage.total_cost_usd, 0.1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report-usage-record.test.js`
Expected: FAIL — `Cannot find module '../src/report/usage-record.js'`.

- [ ] **Step 3: Implement the pure builder**

```js
// src/report/usage-record.js
// Pure shaper: a claude result envelope + the GitHub env → the per-run usage
// record uploaded as an artifact and later aggregated on the host. Keep the raw
// envelope `usage`/cost/turns fields so aggregate's extractUsage reads them.
export function buildUsageRecord(envelope, env = process.env, nowIso = () => new Date().toISOString()) {
  const e = envelope && typeof envelope === 'object' ? envelope : {};
  const u = e.usage && typeof e.usage === 'object' ? e.usage : {};
  return {
    ts: nowIso(),
    workflow: env.GITHUB_WORKFLOW || null,
    runId: env.GITHUB_RUN_ID || null,
    ref: env.GITHUB_REF || null,
    usage: {
      input_tokens: u.input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
      total_cost_usd: e.total_cost_usd ?? null,
      num_turns: e.num_turns ?? null,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/report-usage-record.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the emit into `assert-run-healthy.mjs` (never alters the gate's exit code)**

In `scripts/assert-run-healthy.mjs`, add the import near the top:

```js
import { writeFileSync } from 'node:fs';
import { buildUsageRecord } from '../src/report/usage-record.js';
```

Immediately AFTER the `const envelope = extractResultEnvelope(parsed);` line (before the fatal-exit block), insert:

```js
// Capture token usage for the daily report. Best-effort: a failure here must
// NEVER change the health gate's verdict (the run still consumed the tokens).
if (process.env.MESH_USAGE_OUT) {
  try {
    writeFileSync(process.env.MESH_USAGE_OUT, JSON.stringify(buildUsageRecord(envelope, process.env)));
  } catch (e) {
    console.warn(`::warning::usage capture failed (non-fatal): ${e.message}`);
  }
}
```

- [ ] **Step 6: Verify the gate still passes its own behavior**

Run: `node --test test/dev-mesh-workflow.test.js`
Expected: PASS (the existing honesty-gate coverage is unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/report/usage-record.js test/report-usage-record.test.js scripts/assert-run-healthy.mjs
git commit -m "feat(report): capture per-run token usage from assert-run-healthy (best-effort)"
```

---

## Task 8: `agent-postrun` composite action

**Files:**
- Create: `.github/actions/agent-postrun/action.yml`

- [ ] **Step 1: Write the composite action**

```yaml
# .github/actions/agent-postrun/action.yml
# Post-run seam for every Dev-mesh agent workflow: run the honesty gate AND
# capture the run's token usage as an artifact for the Daily Mesh Report.
# The gate's pass/fail is authoritative; usage capture is best-effort.
name: agent-postrun
description: Honesty-gate the agent run and capture its token usage as an artifact.
inputs:
  execution_file:
    description: Path to the claude execution output JSON (steps.claude.outputs.execution_file)
    required: true
  advisory_blocked:
    description: Pass --advisory-blocked (light ask/comment roles)
    required: false
    default: "false"
runs:
  using: composite
  steps:
    - name: Capture usage artifact (best-effort)
      if: always()
      shell: bash
      env:
        CLAUDE_EXECUTION_FILE: ${{ inputs.execution_file }}
        MESH_USAGE_OUT: ${{ runner.temp }}/mesh-usage.json
      run: |
        node scripts/assert-run-healthy.mjs ${{ inputs.advisory_blocked == 'true' && '--advisory-blocked' || '' }} || EXIT=$?
        # Surface usage file existence for debugging; do not mask the gate exit.
        [ -f "$MESH_USAGE_OUT" ] && echo "captured usage at $MESH_USAGE_OUT" || echo "no usage captured"
        exit ${EXIT:-0}
    - name: Upload usage artifact
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: mesh-usage-${{ github.run_id }}
        path: ${{ runner.temp }}/mesh-usage.json
        retention-days: 7
        if-no-files-found: ignore
```

Note: `assert-run-healthy.mjs` writes `MESH_USAGE_OUT` BEFORE its own fatal exit (Task 7), so the file exists even when the gate fails — the upload step (`if: always()`) still captures it. `|| EXIT=$?` preserves the gate's non-zero exit so the job still fails on real unhealth.

- [ ] **Step 2: Lint the YAML loads**

Run: `node -e "const f=require('fs').readFileSync('.github/actions/agent-postrun/action.yml','utf8'); if(!/using: composite/.test(f)||!/upload-artifact/.test(f)) throw new Error('shape'); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/actions/agent-postrun/action.yml
git commit -m "feat(ci): agent-postrun composite — health gate + usage artifact"
```

---

## Task 9: Switch the workflows to the composite action

**Files:**
- Modify each dev-mesh agent workflow that currently ends with `run: node scripts/assert-run-healthy.mjs …`
- Modify: `test/integration-workflow.test.js`

Affected workflows (the ones with a `claude` step + assert): `dev-mesh-review.yml`, `dev-mesh-triage.yml`, `dev-mesh-intake.yml`, `dev-mesh-research.yml`, `dev-mesh-backlog.yml`, `dev-mesh-curate.yml`, `dev-mesh-autofix.yml`, `dev-mesh-mergefix.yml`, `dev-mesh-ci-sweep.yml`, `dev-mesh-dogfood.yml`, `dev-mesh-memory-automerge.yml`, `dev-mesh-pr-janitor.yml`, `dev-mesh-review-respond.yml`, `dev-mesh-health.yml`.

- [ ] **Step 1: Confirm the exact set to edit**

Run: `grep -rl "assert-run-healthy" .github/workflows/`
Expected: the list of workflow files. Edit exactly these.

- [ ] **Step 2: In EACH listed workflow, replace the assert step**

Find the step (the flag is `--advisory-blocked` for light roles, absent for do-mode pushers):

```yaml
      - name: Verify the agent actually worked (green != healthy)
        if: always()
        env:
          CLAUDE_EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}
        run: node scripts/assert-run-healthy.mjs --advisory-blocked
```

Replace it with:

```yaml
      - name: Verify the agent worked + capture usage
        if: always()
        uses: ./.github/actions/agent-postrun
        with:
          execution_file: ${{ steps.claude.outputs.execution_file }}
          advisory_blocked: "true"
```

For workflows WITHOUT `--advisory-blocked` (do-mode pushers), set `advisory_blocked: "false"`. Keep each workflow's existing flag choice — do not change which workflows are advisory.

- [ ] **Step 3: Add a lint test asserting every agent workflow uses the composite**

In `test/integration-workflow.test.js`, add:

```js
test('every workflow that runs an agent uses agent-postrun (gate + usage capture)', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  for (const f of files) {
    const body = readFileSync(new URL(f, dir), 'utf8');
    if (!body.includes('steps.claude.outputs.execution_file')) continue;   // not an agent workflow
    assert.ok(body.includes('uses: ./.github/actions/agent-postrun'),
      `${f} runs an agent but does not use agent-postrun`);
    assert.ok(!/run: node scripts\/assert-run-healthy\.mjs/.test(body),
      `${f} still calls assert-run-healthy directly; route it through agent-postrun`);
  }
});
```

Ensure `readdirSync`, `readFileSync` are imported at the top of the test file (add if missing).

- [ ] **Step 4: Run the lint test**

Run: `node --test test/integration-workflow.test.js`
Expected: PASS — every agent workflow references the composite; none call the script directly.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ test/integration-workflow.test.js
git commit -m "feat(ci): route agent workflows through agent-postrun (usage capture)"
```

---

## Task 10: `fetchCiUsage` — pull + parse usage artifacts

**Files:**
- Modify: `src/report/sources.js` (replace the Task 5 stub)
- Test: `test/report-sources.test.js` (add a case)

- [ ] **Step 1: Write the failing test**

```js
// add to test/report-sources.test.js
import { fetchCiUsage } from '../src/report/sources.js';

test('fetchCiUsage lists in-window runs, downloads usage, marks missing as uncaptured', async () => {
  const gh = async (args) => {
    if (args[0] === 'run' && args[1] === 'list')
      return JSON.stringify([
        { databaseId: 1, workflowName: 'dev-mesh-review', createdAt: '2026-06-18T09:00:00Z' },
        { databaseId: 2, workflowName: 'dev-mesh-triage', createdAt: '2026-06-18T10:00:00Z' },
        { databaseId: 3, workflowName: 'old', createdAt: '2026-06-10T00:00:00Z' }, // out of window
      ]);
    if (args[0] === 'run' && args[1] === 'download') {
      const id = args[args.indexOf('--name') + 1];
      if (id === 'mesh-usage-1') return ''; // download writes files; success
      throw new Error('no artifact'); // run 2 has no usage artifact
    }
    return '[]';
  };
  const reads = { 'mesh-usage-1': { ts: '2026-06-18T09:00:00Z', workflow: 'dev-mesh-review', runId: '1', usage: { input_tokens: 5 } } };
  const recs = await fetchCiUsage({
    gh, repo: 'o/r', date: '2026-06-18',
    download: async (name) => reads[name] || (() => { throw new Error('missing'); })(),
  });
  const review = recs.find((r) => r.workflow === 'dev-mesh-review');
  assert.equal(review.usage.input_tokens, 5);
  const triage = recs.find((r) => r.runId === '2');
  assert.equal(triage.uncaptured, true);
  assert.ok(!recs.some((r) => r.workflow === 'old')); // out-of-window dropped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/report-sources.test.js`
Expected: FAIL — `fetchCiUsage` is the Task 5 stub returning `[]`.

- [ ] **Step 3: Replace the stub with the real implementation**

In `src/report/sources.js`, delete the `// P1 stub` `fetchCiUsage` and add:

```js
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Default downloader: `gh run download <id> -n mesh-usage-<id>` into a temp dir,
// then read the single JSON file back. Injected in tests.
async function defaultDownload(gh, repo, runId, dir) {
  await gh(['run', 'download', String(runId), '--repo', repo, '--name', `mesh-usage-${runId}`, '--dir', dir]);
  return JSON.parse(readFileSync(join(dir, 'mesh-usage.json'), 'utf8'));
}

export async function fetchCiUsage({ gh, repo, date, download }) {
  const { fromMs, toMs } = { fromMs: Date.parse(`${date}T00:00:00.000Z`), toMs: Date.parse(`${date}T00:00:00.000Z`) + 86400000 };
  const runs = JSON.parse(await gh(['run', 'list', '--repo', repo, '--limit', '200', '--json', 'databaseId,workflowName,createdAt']));
  const inWindow = runs.filter((r) => { const t = Date.parse(r.createdAt); return t >= fromMs && t < toMs; });
  const out = [];
  for (const r of inWindow) {
    try {
      const rec = download
        ? await download(`mesh-usage-${r.databaseId}`)
        : await (async () => { const dir = mkdtempSync(join(tmpdir(), 'mesh-usage-')); try { return await defaultDownload(gh, repo, r.databaseId, dir); } finally { rmSync(dir, { recursive: true, force: true }); } })();
      out.push({ workflow: r.workflowName, runId: String(r.databaseId), ts: rec.ts || r.createdAt, usage: rec.usage ?? rec });
    } catch {
      out.push({ workflow: r.workflowName, runId: String(r.databaseId), ts: r.createdAt, usage: {}, uncaptured: true });
    }
  }
  return out;
}
```

Note: `aggregate`'s `extractUsage(rec.usage ?? rec)` reads the nested `usage` block these records carry; `uncaptured: true` records contribute zero tokens but increment `tokens.ci.uncaptured`.

- [ ] **Step 4: Run tests**

Run: `node --test test/report-sources.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/sources.js test/report-sources.test.js
git commit -m "feat(report): fetchCiUsage — pull per-run usage artifacts, mark uncaptured"
```

---

## Task 11: Full-suite verification + selftest with CI source live

**Files:** none (verification task).

- [ ] **Step 1: Confirm the entrypoint already wires `fetchCiUsage`**

Task 5's `daily-report.mjs` already calls `fetchCiUsage({ gh, repo: REPO, date })`. With Task 10 it now returns real records. No code change — confirm by reading the entrypoint's `ciRecords` line.

- [ ] **Step 2: Run the selftest**

Run: `node scripts/daily-report.mjs --selftest`
Expected: prints a valid (empty) report; exit 0. (Selftest passes no CI records, so the CI row reads `0 runs`.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — all report tests + existing suite; 0 failures, only the pre-existing `AGENT_MESH_E2E` skips.

- [ ] **Step 4: Commit (no-op if clean) / tag the milestone**

```bash
git commit --allow-empty -m "test(report): P2 both-sources milestone verified (npm test green)"
```

---

## Self-review notes (author)

- **Spec §3 modules** → Tasks 1 (usage), 2 (aggregate), 3 (render), 4+10 (sources), 5 (entrypoint). ✓
- **Spec §4 data model** → Task 2 builds the exact `DailyReport` shape incl. `tokens.ci.uncaptured` and `$0`. ✓
- **Spec §5 CI capture** → Tasks 7 (emit), 8 (composite), 9 (workflows), 10 (pull). ✓
- **Spec §6 rolling issue + idempotent comment** → Task 5 `findOrCreateIssue` + `upsertComment` (PATCH by comment id). ✓
- **Spec §7 scheduling** → Task 6 (launchd StartCalendarInterval / systemd timer). ✓
- **Spec §9 testing** → each task is TDD; workflow shape lint in Task 9. ✓
- **Spec §11 invariants** → Task 7 emit is best-effort (never changes the gate exit); Task 8 preserves the gate's non-zero exit via `|| EXIT=$?`. ✓
- **Deferred:** Spec §8 dashboard (P3) — intentionally not in this plan.
- **Naming consistency:** `extractUsage`, `sumUsage`, `aggregate`, `dayBoundsMs`, `renderMarkdown`, `dailyMarker`, `findDatedCommentId`, `readLocalLogs`, `fetchGhActivity`, `fetchCiUsage`, `buildUsageRecord` — used identically across tasks.
