# Review-First Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the [2026-06-13 review-first session-management spec](../specs/2026-06-13-review-first-session-management-design.md): the dashboard stops spawning terminals (copy-paste resume commands instead), deterministically auto-follows the user's live CLI session via provenance-complete spawn tagging, surfaces exact transcript storage paths, and renders agent history as a stitched cross-session timeline.

**Architecture:** Provenance helpers move to a shared core module (the established `session-transcripts` move pattern) so `delegateTask` — the one spawn chokepoint — can tag every framework spawn with a `worker:*` create event. Two new pure, fully-unit-tested browser modules (`follow-policy.js`, `timeline-model.js`) own the follow decision and the segment model; `session-view.js` consumes them. A pure `resume-command.js` builds per-OS copy commands behind a new validated route; the launcher route stays but the UI stops calling it.

**Tech Stack:** Node ≥ 20, zero deps, `node --test`. CI gate (ubuntu+windows × node 20/22) must stay green — Windows path semantics matter (8.3 lesson: always realpath before encoding).

**Branch:** `claude/dreamy-goodall-vcvash`; after each task's commit the controller pushes to it AND `v0.4-development`.

**Environment baseline:** this sandbox shows 4 pre-existing `change-detect.test.js` failures (git-signing proxy artifact — passes on GitHub CI). "Suite green" locally = exactly those 4 red, nothing else.

---

## File structure

| File | Responsibility |
|---|---|
| `src/session-provenance.js` (new) | shared create/select/open/rotate event store (moved verbatim from session-index) |
| `src/dashboard/session-index.js` | re-exports provenance helpers (back-compat); unchanged otherwise |
| `src/delegate.js` | spawn tagging: generate `session` when absent + best-effort `worker:*` provenance |
| `src/delegate-invocation.js` | session argv applied in BOTH modes (verify/extend) |
| `src/dashboard/resume-command.js` (new) | pure per-OS resume-command builder |
| `src/dashboard/server.js` | `resume-command` route; `projectsDir` on `/session/list`; deprecation note on `/open-terminal` |
| `src/dashboard/public/follow-policy.js` (new) | pure follow decision |
| `src/dashboard/public/timeline-model.js` (new) | pure stitched-segment model |
| `src/dashboard/public/session-view.js` | follow integration, stitched rendering, badge/pin, copy button |
| `src/dashboard/public/session-log.js` | ⌘ Terminal → ⧉ Copy resume command; storage line |

---

### Task 1: Shared provenance module

**Files:**
- Create: `src/session-provenance.js`
- Modify: `src/dashboard/session-index.js` (delete moved code, re-export)
- Test: `test/session-provenance.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/session-provenance.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as shared from '../src/session-provenance.js';
import * as index from '../src/dashboard/session-index.js';

test('provenance helpers live in the shared module and round-trip', async () => {
  assert.equal(typeof shared.recordEvent, 'function');
  assert.equal(typeof shared.readEvents, 'function');
  assert.equal(typeof shared.deriveProvenance, 'function');
  const meshRoot = await mkdtemp(join(tmpdir(), 'prov-'));
  await shared.recordEvent(meshRoot, { kind: 'create', source: 'worker:digest', sessionId: 'x', agentRoot: '/a' });
  const events = await shared.readEvents(meshRoot);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'worker:digest');
});

test('session-index re-exports are the SAME functions (back-compat)', () => {
  assert.equal(index.recordEvent, shared.recordEvent);
  assert.equal(index.readEvents, shared.readEvents);
  assert.equal(index.deriveProvenance, shared.deriveProvenance);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-provenance.test.js` — FAIL (module missing).

- [ ] **Step 3: Move the code**

Create `src/session-provenance.js` with — moved **verbatim** from `src/dashboard/session-index.js` — the `hash` helper, `sessionsDir`, `eventsPath`, `recordEvent`, `readEvents`, and `deriveProvenance` (keep all comments, including the rotate-births-generation note), under this header:

```js
// src/session-provenance.js — shared session management-event store (moved
// verbatim from src/dashboard/session-index.js — 2026-06-13 spec §3: core
// delegate.js must tag framework spawns without importing dashboard code;
// session-index re-exports for back-compat). Events live under the runtime
// temp dir keyed by mesh root: <tmp>/agent-mesh/sessions/<hash>/events.jsonl.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
```

CAREFUL: `sessionsDir`/`hash` are ALSO used by `labelsPath` (labels stay in session-index). Export `sessionsDir` from the new module and have session-index import it for `labelsPath`. In `src/dashboard/session-index.js`: delete the moved code, add

```js
export { recordEvent, readEvents, deriveProvenance } from '../session-provenance.js';
import { recordEvent, readEvents, deriveProvenance, sessionsDir } from '../session-provenance.js';
```

and keep `labelsPath(meshRoot) { return join(sessionsDir(meshRoot), 'labels.json'); }` working. Verify no other private use of `hash` remains (session-store has its own copy — untouched).

- [ ] **Step 4: Run tests**

Run: `node --test test/session-provenance.test.js test/session-index.test.js test/session-headroom-rows.test.js test/session-routes.test.js` — all green. Then `node run-all-tests.mjs` → only the 4 change-detect baseline reds.

- [ ] **Step 5: Commit**

```bash
git add src/session-provenance.js src/dashboard/session-index.js test/session-provenance.test.js
git commit -m "refactor(provenance): shared session-event store (core may tag spawns)"
```

---

### Task 2: Spawn tagging in delegateTask

**Files:**
- Modify: `src/delegate.js` (~line 130-140, before `buildClaudeInvocation`)
- Modify: `src/delegate-invocation.js` (session argv in BOTH modes — verify/extend)
- Test: `test/delegate-invocation.test.js` + `test/delegate.test.js` (extend)

- [ ] **Step 1: Read the current session plumbing**

Read `src/delegate-invocation.js` `buildClaudeInvocation`: find where `session` produces `['--resume'|'--session-id', id]` args. If it is gated to `mode === 'ask'`, note it — Step 3 removes that gate (both modes write transcripts; spec §3). Read `src/delegate.js:130-145` (env/`entered` context, the `buildClaudeInvocation` call, and the retry at :168 which passes `session` through — the generated session must flow the same way).

- [ ] **Step 2: Write the failing tests**

Append to `test/delegate-invocation.test.js` (reuse its existing builder-call fixtures):

```js
test('buildClaudeInvocation applies session args in do mode too (tagging)', async () => {
  // mirror this file's existing ask-mode session test, with mode: 'do' and
  // session { id: 'dddddddd-1111-4222-8333-444444444444', resume: false } —
  // assert args contain ['--session-id', id].
});
```

Append to `test/delegate.test.js` (reuse `createFakeClaude` + its temp-root fixture; import `readEvents` from `../src/session-provenance.js`):

```js
test('sessionless delegations are tagged: --session-id generated + worker:<route> provenance', async () => {
  const meshCeiling = await mkdtemp(join(tmpdir(), 'tagmesh-'));
  const r = await delegateTask({
    root, env: { ...baseEnv, AGENT_MESH_MESH_CEILING: meshCeiling },
    input: { mode: 'ask', task: 'hi' }, route: 'digest'
  });
  assert.equal(r.status, 'done');
  assert.match(r.argv.join(' '), /--session-id [0-9a-f-]{36}/);
  const events = await readEvents(meshCeiling);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'create');
  assert.equal(events[0].source, 'worker:digest');
  assert.match(events[0].sessionId, /^[0-9a-f-]{36}$/);
});

test('no mesh env → no provenance event, delegation unaffected; explicit session untouched', async () => {
  const r = await delegateTask({ root, env: baseEnv, input: { mode: 'ask', task: 'hi' } });
  assert.equal(r.status, 'done'); // tagged argv still fine, just no event store to write
  const explicit = { id: 'eeeeeeee-1111-4222-8333-444444444444', resume: false };
  const r2 = await delegateTask({ root, env: baseEnv, input: { mode: 'ask', task: 'hi' }, session: explicit });
  assert.match(r2.argv.join(' '), new RegExp(`--session-id ${explicit.id}`));
});
```

(Adapt fixture/helper names to the file's actual ones — `delegate.test.js` defines `createFakeClaude` and result shapes; `r.argv` exists per delegate.js:215 `compactArgv`. If argv tail-compaction drops the flag, assert via the run-log JSON instead — the START record carries argv.)

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/delegate-invocation.test.js test/delegate.test.js` — new tests FAIL.

- [ ] **Step 4: Implement**

In `src/delegate-invocation.js`: if session argv is ask-gated, change the gate so both modes apply `[session.resume ? '--resume' : '--session-id', session.id]` (keep everything else identical).

In `src/delegate.js`, immediately before the `buildClaudeInvocation` call (~:138):

```js
  // Spawn tagging (2026-06-13 spec §3): every framework spawn gets a known
  // session id so its transcript is identifiable as worker-origin — the
  // dashboard's auto-follow then never mistakes a scheduler/digest/delegate
  // run for the user's own CLI session. Framework-side only: the model-facing
  // surface stays {mode, task}. Best-effort — tagging never fails a turn.
  let taggedSession = session;
  if (!taggedSession) {
    taggedSession = { id: randomUUID(), resume: false };
    const meshRoot = env?.AGENT_MESH_MESH_CEILING;
    if (meshRoot) {
      try {
        await recordEvent(meshRoot, {
          kind: 'create', source: `worker:${route || mode}`,
          sessionId: taggedSession.id, agentRoot: root
        });
      } catch { /* provenance is observability, never load-bearing for the turn */ }
    }
  }
```

then use `taggedSession` everywhere `session` was used below (the invocation call AND the `:168` resume-retry guard — the retry condition `session && session.resume` must read `taggedSession.resume`, which is `false` for generated ids, so generated sessions never enter the resume-retry path). Imports: `randomUUID` from `node:crypto` (check if already imported), `recordEvent` from `./session-provenance.js`. `mode` is already in scope (destructured from input — verify the local name).

- [ ] **Step 5: Run tests**

Run: `node --test test/delegate-invocation.test.js test/delegate.test.js test/multi-turn-delegate.test.js test/peer-bridge.test.js test/digest.test.js test/scheduler.test.js` — all green (peer path passes explicit sessions → untouched; digest/scheduler now tagged, their tests don't assert argv absence — if one does, update it to expect the flag and say so in the report). Then `node run-all-tests.mjs` → baseline only.

- [ ] **Step 6: Commit**

```bash
git add src/delegate.js src/delegate-invocation.js test/delegate-invocation.test.js test/delegate.test.js
git commit -m "feat(delegate): provenance-complete spawn tagging — worker:<route> create events"
```

---

### Task 3: Follow-policy pure module

**Files:**
- Create: `src/dashboard/public/follow-policy.js`
- Test: `test/follow-policy.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/follow-policy.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { followTarget, isUserOrigin } from '../src/dashboard/public/follow-policy.js';

const row = (id, { origin = 'cli', active = false, endedAt = 0 } = {}) =>
  ({ id, originSource: origin, active, endedAt });

test('isUserOrigin: cli and dashboard yes; peer/worker/headroom no', () => {
  assert.equal(isUserOrigin('cli'), true);
  assert.equal(isUserOrigin('dashboard'), true);
  assert.equal(isUserOrigin('peer:B'), false);
  assert.equal(isUserOrigin('worker:digest'), false);
  assert.equal(isUserOrigin('headroom'), true); // rotated-in generations are user threads
});

test('pin wins over everything', () => {
  const rows = [row('live', { active: true, endedAt: 100 }), row('pinned')];
  const got = followTarget(rows, { currentId: 'live', pinnedId: 'pinned', lastSeen: {}, canonicalId: 'live' });
  assert.equal(got, 'pinned');
});

test('a grown user-origin session beats canonical; worker/peer growth never followed', () => {
  const rows = [
    row('canon', { origin: 'dashboard', endedAt: 50 }),
    row('mine', { origin: 'cli', active: true, endedAt: 200 }),
    row('digestrun', { origin: 'worker:digest', active: true, endedAt: 300 }),
    row('peer', { origin: 'peer:B', active: true, endedAt: 400 })
  ];
  const got = followTarget(rows, { currentId: null, pinnedId: null, canonicalId: 'canon',
    lastSeen: { mine: 100, digestrun: 100, peer: 100 } });
  assert.equal(got, 'mine');
});

test('sticky: current stays while active even if another user session grew', () => {
  const rows = [
    row('a', { active: true, endedAt: 300 }),
    row('b', { active: true, endedAt: 500 })
  ];
  const got = followTarget(rows, { currentId: 'a', pinnedId: null, canonicalId: null,
    lastSeen: { a: 200, b: 200 } });
  assert.equal(got, 'a');
});

test('quiet current + grown other → switch; fallback chain canonical → newest', () => {
  const rows = [row('a', { active: false, endedAt: 100 }), row('b', { active: true, endedAt: 500 })];
  assert.equal(followTarget(rows, { currentId: 'a', pinnedId: null, canonicalId: null, lastSeen: { b: 400 } }), 'b');
  const quietRows = [row('x', { endedAt: 10 }), row('canon', { origin: 'dashboard', endedAt: 5 })];
  assert.equal(followTarget(quietRows, { currentId: null, pinnedId: null, canonicalId: 'canon', lastSeen: {} }), 'canon');
  assert.equal(followTarget(quietRows, { currentId: null, pinnedId: null, canonicalId: 'gone', lastSeen: {} }), 'x');
  assert.equal(followTarget([], { currentId: null, pinnedId: null, canonicalId: null, lastSeen: {} }), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/follow-policy.test.js` — FAIL.

- [ ] **Step 3: Implement**

Create `src/dashboard/public/follow-policy.js`:

```js
/**
 * src/dashboard/public/follow-policy.js — PURE.
 * Which session should the canvas track? (2026-06-13 spec §4)
 *   pin > live USER session (grew since last poll) > sticky current-while-active
 *   > canonical > newest. peer:*/worker:* sessions are framework spawns and are
 * never auto-followed (reviewable by explicit click only).
 */
export function isUserOrigin(originSource) {
  const o = String(originSource || 'cli');
  return !(o.startsWith('peer:') || o.startsWith('worker:'));
}

export function followTarget(rows, { currentId, pinnedId, canonicalId, lastSeen }) {
  if (pinnedId && rows.some((r) => r.id === pinnedId)) return pinnedId;
  const current = rows.find((r) => r.id === currentId);
  // Sticky: never leave an actively-followed session (no flapping mid-thought).
  if (current && current.active) return currentId;
  // Live user session: grew since the previous poll, user-origin, most recent first.
  const grown = rows
    .filter((r) => isUserOrigin(r.originSource))
    .filter((r) => r.active && lastSeen[r.id] !== undefined && r.endedAt > lastSeen[r.id])
    .sort((a, b) => b.endedAt - a.endedAt);
  if (grown.length) return grown[0].id;
  if (current) return currentId; // quiet but still listed — hold position
  if (canonicalId && rows.some((r) => r.id === canonicalId)) return canonicalId;
  return rows.length ? rows.slice().sort((a, b) => b.endedAt - a.endedAt)[0].id : null;
}
```

NOTE the sticky ordering: current-active wins BEFORE grown-check (test 4 pins this); a brand-new session is followed because the FIRST poll seeds `lastSeen` and the SECOND observes growth — and when no current exists, the fallback chain takes the newest, which for a just-created transcript is the new session. Verify all five tests pass; if test 5's `'b'` case conflicts with sticky-hold (`current 'a'` inactive → fall through, correct), re-read rather than weaken tests.

- [ ] **Step 4: Run tests**

Run: `node --test test/follow-policy.test.js` — 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/follow-policy.js test/follow-policy.test.js
git commit -m "feat(follow): pure follow-policy — pin > live user session > sticky > canonical"
```

---

### Task 4: Resume-command builder + route + UI swap

**Files:**
- Create: `src/dashboard/resume-command.js`
- Modify: `src/dashboard/server.js` (new route near `/open-terminal`; deprecation comment on it)
- Modify: `src/dashboard/public/session-log.js` (button + handler swap)
- Modify: `src/dashboard/public/session-view.js` (renderEmpty's button)
- Test: `test/resume-command.test.js` (new) + `test/session-routes.test.js` (extend)

- [ ] **Step 1: Write the failing builder test**

Create `test/resume-command.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeCommand } from '../src/dashboard/resume-command.js';

test('win32: PowerShell-quoted cd; resume with exact id; embedded quotes doubled', () => {
  const c = buildResumeCommand({ agentRoot: "C:\\agents\\o'brien lab", sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'resume', platform: 'win32' });
  assert.equal(c.shell, 'powershell');
  assert.equal(c.command, "cd 'C:\\agents\\o''brien lab'; claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test('posix: && chaining and single-quote escaping', () => {
  const c = buildResumeCommand({ agentRoot: "/srv/o'brien lab", sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'resume', platform: 'linux' });
  assert.equal(c.shell, 'sh');
  assert.equal(c.command, "cd '/srv/o'\\''brien lab' && claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test('mode new → bare claude; mode seed → --session-id (reserved canonical first launch)', () => {
  assert.match(buildResumeCommand({ agentRoot: '/a', mode: 'new', platform: 'linux' }).command, /&& claude$/);
  assert.match(buildResumeCommand({ agentRoot: '/a', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'seed', platform: 'linux' }).command, /--session-id aaaaaaaa/);
});

test('invalid session id throws (defense in depth — route validates first)', () => {
  assert.throws(() => buildResumeCommand({ agentRoot: '/a', sessionId: 'x; rm -rf /', mode: 'resume', platform: 'linux' }), /bad session id/);
});
```

- [ ] **Step 2: Run to verify it fails**, then implement `src/dashboard/resume-command.js`:

```js
/**
 * src/dashboard/resume-command.js — PURE. Build the copy-paste command that
 * replaces the terminal launcher (2026-06-13 spec §5). Inputs are framework-
 * validated upstream (manifest-resolved root, UUID id); quoting here is
 * defense in depth, not the security boundary. Always an exact id
 * (--resume/--session-id), never `--continue` (recency heuristic — CLAUDE.md).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function buildResumeCommand({ agentRoot, sessionId = null, mode, platform = process.platform }) {
  if (mode !== 'new') {
    if (!UUID_RE.test(String(sessionId))) throw Object.assign(new Error('bad session id'), { code: 'bad_id' });
  }
  const claude = mode === 'new' ? 'claude'
    : mode === 'seed' ? `claude --session-id ${sessionId}`
    : `claude --resume ${sessionId}`;
  if (platform === 'win32') {
    return { shell: 'powershell', cwd: agentRoot, command: `cd ${psQuote(agentRoot)}; ${claude}` };
  }
  return { shell: 'sh', cwd: agentRoot, command: `cd ${shQuote(agentRoot)} && ${claude}` };
}
```

Run: `node --test test/resume-command.test.js` — 4/4.

- [ ] **Step 3: Route — failing test first**

In `test/session-routes.test.js`, mirror the existing `/session/list` harness:

```js
test('resume-command route: exact id, latest (user-origin first), new, seed, 404', async (t) => {
  // seed one user-origin transcript + one worker-origin (newer) like the list fixtures
  const r1 = await getJson(`/api/agent/${AGENT_NAME}/session/resume-command?id=${SID}`);
  assert.match(r1.command, new RegExp(`--resume ${SID}`));
  assert.ok(r1.cwd.length > 0);
  const r2 = await getJson(`/api/agent/${AGENT_NAME}/session/resume-command?id=latest`);
  assert.match(r2.command, new RegExp(`--resume ${SID}`)); // user-origin beats newer worker row
  const r3 = await getJson(`/api/agent/${AGENT_NAME}/session/resume-command?id=new`);
  assert.match(r3.command, /claude$/);
  const bad = await getStatus(`/api/agent/${AGENT_NAME}/session/resume-command?id=99999999-9999-4999-8999-999999999999`);
  assert.equal(bad, 404);
});
```

(Adapt helper names; for the `seed` case reuse the reserved-canonical fixture the `/open-terminal` tests already build — same rule: stored canonical id with no transcript → `--session-id`.)

- [ ] **Step 4: Implement the route**

In `src/dashboard/server.js`, beside the `/open-terminal` block (same `verb` dispatch — register verb `resume-command`, GET; note `/open-terminal` gets a one-line comment `// DEPRECATED (2026-06-13 spec §5): UI uses resume-command copy flow; route kept for API compat.`):

```js
    if (verb === 'resume-command' && req.method === 'GET') {
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      const want = url.searchParams.get('id') || 'latest';
      let mode = 'resume', sid = want;
      if (want === 'new') { mode = 'new'; sid = null; }
      else {
        if (want === 'latest') {
          const rows = await sessionIndex.listSessions(canonRoot);
          const user = rows.filter((s) => { const o = String(s.originSource || 'cli'); return !(o.startsWith('peer:') || o.startsWith('worker:')); });
          sid = user[0]?.id ?? (await readSessionId(meshRoot, canonRoot).catch(() => null)) ?? rows[0]?.id ?? null;
          if (!sid) { sendJson(res, 404, { ok: false, error: { code: 'not_found' } }); return; }
        }
        try { await sessionIndex.resolveTranscript(canonRoot, sid); }
        catch (e) {
          const canonical = e.code === 'not_found' ? await readSessionId(meshRoot, canonRoot).catch(() => null) : null;
          if (canonical && canonical === sid) mode = 'seed';   // reserved first launch
          else { sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } }); return; }
        }
      }
      try {
        sendJson(res, 200, { ok: true, ...buildResumeCommand({ agentRoot: canonRoot, sessionId: sid, mode }) });
      } catch (e) { sendJson(res, 404, { ok: false, error: { code: e.code || 'bad_id' } }); }
      return;
    }
```

Import `buildResumeCommand` at the top. `listSessions` rows are newest-first (rows.sort by endedAt) — `user[0]` is the latest user session.

- [ ] **Step 5: UI swap**

`src/dashboard/public/session-log.js`: change the `#sl-term` button label/title to `⧉ Copy resume command` / `Copy a command that resumes this session in YOUR terminal (nothing is launched)`; replace the `decideTerminalAction`/launch handler with:

```js
  async function copyResume(idOrKeyword) {
    let j;
    try { j = await (await api(`/session/resume-command?id=${encodeURIComponent(idOrKeyword)}`)).json(); }
    catch { flash('Could not build the resume command'); return; }
    if (!j.ok) { flash(`No command: ${j.error?.code || 'unknown'}`); return; }
    try { await navigator.clipboard.writeText(j.command); flash('Copied — paste in your terminal'); }
    catch { flash(j.command); } // clipboard blocked → show it for manual copy
  }
```

wired as `copyResume(openId || 'latest')`; the empty-state copy (line ~263) becomes "No session yet. Run `claude` in this agent's folder (⧉ copy the command) — it will surface here within a few seconds." with a `copyResume('new')` button. Same swap for `#sv-term`/`onTerminal` in `src/dashboard/public/session-view.js` `renderEmpty`. Do NOT remove `/open-terminal` server code.

- [ ] **Step 6: Run tests + commit**

Run: `node --test test/resume-command.test.js test/session-routes.test.js test/session-log-frontend.test.js test/shell-endpoint.test.js` → green (shell-endpoint still tests the deprecated route — unchanged behavior). `node run-all-tests.mjs` → baseline only.

```bash
git add src/dashboard/resume-command.js src/dashboard/server.js src/dashboard/public/session-log.js src/dashboard/public/session-view.js test/resume-command.test.js test/session-routes.test.js
git commit -m "feat(dashboard): copy resume-command replaces terminal spawning (EDR-proof)"
```

---

### Task 5: Storage transparency

**Files:**
- Modify: `src/dashboard/server.js` (`/session/list` response)
- Modify: `src/dashboard/public/session-log.js` (storage line)
- Test: `test/session-routes.test.js` (extend)

- [ ] **Step 1: Failing test** — in the existing `/session/list` test add:

```js
  assert.ok(res.projectsDir.includes('projects'));          // exact transcript dir
  assert.ok(res.sessions.every((s) => !s.transcriptPath || s.transcriptPath.startsWith(res.projectsDir)));
```

- [ ] **Step 2: Implement** — in the list route, before `sendJson`:

```js
      const { encodeProjectDir } = await import('../session-transcripts.js');
      const { join: joinPath } = await import('node:path');
      const { homedir } = await import('node:os');
      const projectsDir = joinPath(homedir(), '.claude', 'projects', encodeProjectDir(canonRoot));
```

NO — server.js uses static imports throughout; add `encodeProjectDir` to its existing import from session-index (re-exported) and compute with statics:

```js
      const projectsDir = join(homedir(), '.claude', 'projects', encodeProjectDir(canonRoot));
```

(`join`/`homedir` — check existing imports, add if missing) and include `projectsDir` in the response object. `canonRoot` is already realpathed in that block (8.3-safe).

- [ ] **Step 3: UI** — in `session-log.js`'s meta rendering add a storage row:

```js
    rows.push(['stored in', truncate(j.projectsDir || '', 60)]);
```

(thread `j.projectsDir` from the list fetch the same way `digesting` was threaded; a click on the row copies the full path via `navigator.clipboard` with the same flash fallback).

- [ ] **Step 4: Test + commit**

`node --test test/session-routes.test.js` green.

```bash
git add src/dashboard/server.js src/dashboard/public/session-log.js test/session-routes.test.js
git commit -m "feat(dashboard): surface exact transcript storage paths per agent"
```

---

### Task 6: Timeline model (pure)

**Files:**
- Create: `src/dashboard/public/timeline-model.js`
- Test: `test/timeline-model.test.js` (new)

- [ ] **Step 1: Failing tests** — create `test/timeline-model.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, MAX_STITCHED_SEGMENTS, dividerLabel } from '../src/dashboard/public/timeline-model.js';

const meta = (id, origin = 'cli', startedAt = 1) => ({ id, originSource: origin, startedAt });

test('dividerLabel: rotate provenance > origin wording', () => {
  assert.equal(dividerLabel({ originSource: 'headroom' }), 'generation rotated (digest applied)');
  assert.equal(dividerLabel({ originSource: 'cli' }), 'new CLI session');
  assert.equal(dividerLabel({ originSource: 'dashboard' }), 'dashboard session');
});

test('switching follow seals the current segment and appends the new one', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.append('a', { seq: 1, events: [{ type: 'user_text', text: 'hi' }] });
  tl.openSegment(meta('b', 'cli', 2));
  tl.append('b', { seq: 1, events: [{ type: 'text', text: 'yo' }] });
  const segs = tl.segments();
  assert.deepEqual(segs.map((s) => s.sessionId), ['a', 'b']);
  assert.equal(segs[0].sealed, true);
  assert.equal(segs[0].records.length, 1);          // sealed keeps records
  assert.equal(tl.liveSessionId(), 'b');
});

test('records address as (sessionId, seq): appends to a sealed segment are ignored', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.openSegment(meta('b'));
  tl.append('a', { seq: 2, events: [] });
  assert.equal(tl.segments()[0].records.length, 0);
});

test('re-opening the SAME id is a no-op (no duplicate segments on poll jitter)', () => {
  const tl = createTimeline();
  tl.openSegment(meta('a'));
  tl.openSegment(meta('a'));
  assert.equal(tl.segments().length, 1);
});

test('eviction beyond MAX_STITCHED_SEGMENTS drops oldest', () => {
  const tl = createTimeline();
  for (let i = 0; i < MAX_STITCHED_SEGMENTS + 2; i++) tl.openSegment(meta(`s${i}`, 'cli', i));
  const segs = tl.segments();
  assert.equal(segs.length, MAX_STITCHED_SEGMENTS);
  assert.equal(segs[0].sessionId, 's2');
});

test('prependHistory loads an older session ABOVE existing segments', () => {
  const tl = createTimeline();
  tl.openSegment(meta('live', 'cli', 10));
  tl.prependHistory(meta('old', 'dashboard', 1), [{ seq: 1, events: [] }]);
  const segs = tl.segments();
  assert.deepEqual(segs.map((s) => s.sessionId), ['old', 'live']);
  assert.equal(segs[0].sealed, true);
});
```

- [ ] **Step 2: Run (FAIL), implement** `src/dashboard/public/timeline-model.js`:

```js
/**
 * src/dashboard/public/timeline-model.js — PURE.
 * Stitched cross-session canvas model (2026-06-13 spec §7): an ordered list of
 * segments, exactly one live (last). Sealing keeps records; switching never
 * clears. Records address as (sessionId, seq) — seq stays per-session.
 */
export const MAX_STITCHED_SEGMENTS = 8;

export function dividerLabel(metaOrRow) {
  const o = String(metaOrRow.originSource || 'cli');
  if (o === 'headroom') return 'generation rotated (digest applied)';
  if (o === 'dashboard') return 'dashboard session';
  return 'new CLI session';
}

export function createTimeline() {
  let segments = []; // { sessionId, startedAt, originSource, label, sealed, records[] }

  const seal = () => { const live = segments[segments.length - 1]; if (live) live.sealed = true; };
  const evict = () => { while (segments.length > MAX_STITCHED_SEGMENTS) segments.shift(); };

  return {
    openSegment(meta) {
      if (segments.length && segments[segments.length - 1].sessionId === meta.id) return;
      seal();
      segments.push({ sessionId: meta.id, startedAt: meta.startedAt ?? Date.now(),
        originSource: meta.originSource || 'cli', label: dividerLabel(meta), sealed: false, records: [] });
      evict();
    },
    append(sessionId, rec) {
      const live = segments[segments.length - 1];
      if (!live || live.sessionId !== sessionId || live.sealed) return; // sealed = static history
      live.records.push(rec);
    },
    prependHistory(meta, records) {
      segments.unshift({ sessionId: meta.id, startedAt: meta.startedAt ?? 0,
        originSource: meta.originSource || 'cli', label: dividerLabel(meta), sealed: true,
        records: records.slice() });
      evict();
    },
    seedLive(sessionId, records) {           // windowed /transcript load for the live segment
      const live = segments[segments.length - 1];
      if (live && live.sessionId === sessionId && !live.sealed) live.records = records.slice();
    },
    segments: () => segments,
    liveSessionId: () => (segments.length ? segments[segments.length - 1].sessionId : null)
  };
}
```

Run: `node --test test/timeline-model.test.js` — 6/6 (note eviction test: 10 opens → oldest two evicted → first is `s2`).

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/public/timeline-model.js test/timeline-model.test.js
git commit -m "feat(timeline): pure stitched-segment model — seal on switch, never clear"
```

---

### Task 7: session-view integration (follow + stitched canvas + badge/pin)

**Files:**
- Modify: `src/dashboard/public/session-view.js`
- Test: `test/session-log-frontend.test.js` / `test/session-model.test.js` style checks where applicable; primary safety net = the pure modules (Tasks 3/6) + existing route/frontend suites staying green

This is the one rendering-heavy task; the MODEL decisions are all made (Tasks 3/6) — this task wires them. READ `src/dashboard/public/session-view.js` fully first. Integration contract:

- [ ] **Step 1: Replace the follow decision.** `loadCanonical()` (the 4 s poll) becomes `loadFollow()`:

```js
  let lastSeen = {};            // id → endedAt at previous poll
  let pinnedId = null;          // set by the pin toggle / divider click
  async function loadFollow() {
    let j;
    try { j = await (await api('/session/list')).json(); } catch { j = { sessions: [] }; }
    if (destroyed) return;
    const rows = j.sessions || [];
    const target = followTarget(rows, { currentId: openId, pinnedId, canonicalId: j.canonicalId || null, lastSeen });
    for (const r of rows) lastSeen[r.id] = r.endedAt;
    if (!target) { renderEmpty(); return; }
    const row = rows.find((r) => r.id === target);
    if (target !== openId) { sessionMeta = row; await openSegmentFor(row); }
    else { sessionMeta = row; renderMeta(); }
  }
```

(import `followTarget` from `./follow-policy.js`; keep the existing 4 s `setInterval` calling `loadFollow`).

- [ ] **Step 2: Stitch instead of clear.** `openSession(primary)` becomes `openSegmentFor(row)`: keep the stream open/close mechanics EXACTLY as today (close old SSE, fetch `/transcript` window, open new stream), but route records through a `createTimeline()` instance instead of the flat `records` array: on switch call `timeline.openSegment({ id: row.id, originSource: row.originSource, startedAt: row.startedAt })`, seed with the windowed load via `timeline.seedLive(row.id, t.records)`, and live SSE records append via `timeline.append(row.id, rec)`. The renderer iterates `timeline.segments()` — each sealed segment renders its records statically under a divider bar (`segment.label` + short id, click = `pinnedId = segment.sessionId` + re-render); the last (live) segment renders as today. Scroll-up at the top of the OLDEST loaded segment fetches the next-older session row's `/transcript` window and calls `timeline.prependHistory(rowMeta, records)`.

- [ ] **Step 3: Badge + pin.** Next to the existing meta header render: `● following live CLI session` when the followed row's origin is `cli` and it is active; `pinned — click to unpin` when `pinnedId` (click clears it); nothing otherwise. Keep it one small element with two states; no new CSS file (inline classes beside the existing `scv2-*` styles).

- [ ] **Step 4: Verify nothing regressed.** `node --test test/session-log-frontend.test.js test/session-model.test.js test/session-routes.test.js test/dashboard-server.test.js` green; `node run-all-tests.mjs` → baseline only. Manually sanity-parse the file (`node --check` equivalent via `new Function` is not available for ESM — run `node --input-type=module -e "import('./src/dashboard/public/session-view.js').catch(e => { console.error(e.message); process.exit(1); })"` — it may fail on browser globals at IMPORT time only if module-level code touches them; if so, skip this check and rely on the frontend test suite, which loads these modules).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/session-view.js
git commit -m "feat(canvas): auto-follow live sessions; stitched timeline with seams and pin"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `PROJECT.md` (changelog), `CLAUDE.md` (architecture line for the new modules), spec §12

- [ ] **Step 1:** PROJECT.md changelog entry (match existing style):
`2026-06-13 — review-first session management: copy resume-commands replace dashboard terminal spawning (EDR-proof), provenance-complete spawn tagging (worker:* create events at the delegateTask chokepoint), deterministic auto-follow of live CLI sessions, per-agent transcript-storage transparency, stitched cross-session canvas timeline. Spec: docs/superpowers/specs/2026-06-13-review-first-session-management-design.md.`

- [ ] **Step 2:** CLAUDE.md architecture section: append one bullet after the session-generations-related entries describing `src/session-provenance.js` (shared event store; delegate tags every framework spawn `worker:<route>` so dashboards distinguish user CLI sessions) and the dashboard pure modules (`follow-policy.js`, `timeline-model.js`, `resume-command.js` — no terminal spawning from the UI anymore; `/open-terminal` deprecated).

- [ ] **Step 3:** Spec §12: replace the pending bullet with the implementation note (branch, plan path, suite status).

- [ ] **Step 4:** `node run-all-tests.mjs` → baseline only. Commit:

```bash
git add PROJECT.md CLAUDE.md docs/superpowers/specs/2026-06-13-review-first-session-management-design.md
git commit -m "docs: review-first session management — changelog, architecture, spec note"
```

Controller then pushes both branches and watches CI (ubuntu+windows × node 20/22) to green.

---

## Self-review checklist (run after Task 8)

- Spec §3→T1/T2, §4→T3+T7, §5→T4, §6→T5, §7→T6+T7, §8 documented behaviors exercised in T3/T4 tests, §9 invariants untouched (no new spawn sites; grep the diff for `spawn(`), §10 test list covered 1:1.
- The deprecated `/open-terminal` still answers (shell-endpoint suite green, untouched).
- CI green on all four matrix jobs before calling it done.
