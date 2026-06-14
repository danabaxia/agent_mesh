# Flow-Change Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `flow-change-protocol` skill — a pure JS engine plus an interactive SKILL.md — that handles a post-spec design change deterministically (classify → surgical staleness cascade → ordered regen) over a git-tracked `flow-state.json`.

**Architecture:** A **pure core** (`flow-change.mjs`: side-effect-free graph functions over a state object, unit-tested with `node --test`) plus a **thin CLI shell** and a **documented interactive SKILL.md** (the impure orchestration with human gates). Mirrors the project's pure-core / impure-shell split. The engine never calls agents or codex.

**Tech Stack:** Node ≥ 20 ESM (`.mjs`), zero dependencies, `node:test` + `node:assert/strict`, `node:crypto` (sha256), `node:child_process` (git HEAD for drift only).

**Spec:** [docs/superpowers/specs/2026-06-07-flow-change-protocol-design.md](../specs/2026-06-07-flow-change-protocol-design.md) (codex-reviewed R1→R5, converged on substance).

---

## File Structure

The skill installs **outside the project repo**, at its final home:

```
~/.claude/skills/flow-change-protocol/
├── SKILL.md                     trigger + 4-step flow + confirm-blast-radius gate  (Task 11)
├── scripts/
│   ├── flow-change.mjs          pure engine + helpers + CLI                         (Tasks 1–8)
│   └── flow-change.test.js      node --test, fixture-driven, zero deps              (Tasks 1–8)
└── references/
    ├── flow-state-schema.md      flow-state.json fields + two-graph model           (Task 9)
    └── bootstrap.md              building the manifest for an existing project       (Task 10)
```

`flow-change.mjs` is one focused module: pure exported functions (the engine), then a `main()` CLI dispatcher guarded by `import.meta.main`-style check. The test file colocates. Because the skill dir is not inside the agents_mesh repo, **Task 0 `git init`s it** so the TDD commit discipline still applies; if you prefer not to version it, treat each green `node --test` run as the checkpoint and skip the commit steps.

### Canonical data shapes (used by every task — keep identical)

```js
// state
{
  schema_version: 1,
  base_sha: "<git HEAD short sha or null>",
  authoritative_phase: "P5",
  phases: ["P0","P1","P2","P3","P4","P5","P6","P7"],
  sections: { "sec-storage": { display: "§2.2", status: "live", alias: null } },
  artifacts: [
    { id, phase, path, status: "fresh"|"stale"|"tombstone",
      sources: [ { ref, provenance: "authored"|"inferred"|"unknown", rationale?, confirmed_at? } ],
      hash, stamp?, alias? }
  ]
}

// a ref is either an artifact id ("task-3") or a section ref ("spec#sec-storage")
// a typed op (Task 2):
{ type: "MODIFY", ref }
{ type: "ADD",    node: { id, phase, path }, sources: [ {ref, provenance} ] }
{ type: "DELETE", ref }
{ type: "RE-EDGE", artifact, newSources: [ {ref, provenance} ] }
```

---

## Task 0: Scaffold the skill directory + local git

**Files:**
- Create: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs` (stub)
- Create: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js` (empty harness)

- [ ] **Step 1: Make the directories and init git**

```bash
mkdir -p ~/.claude/skills/flow-change-protocol/scripts ~/.claude/skills/flow-change-protocol/references
cd ~/.claude/skills/flow-change-protocol && git init -q && printf "node_modules\n" > .gitignore
```

- [ ] **Step 2: Create the engine stub with the helpers section header**

Create `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`:

```js
// flow-change.mjs — pure engine for the flow-change protocol. No agent/codex calls.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---- helpers ----
export const SCHEMA_VERSION = 1;
```

- [ ] **Step 3: Create the test harness**

Create `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from './flow-change.mjs';

// a small fixture builder reused across tests
export function fixture() {
  return {
    schema_version: 1, base_sha: null, authoritative_phase: 'P5',
    phases: ['P0','P1','P2','P3','P4','P5','P6','P7'],
    sections: { 'sec-storage': { display: '§2.2', status: 'live', alias: null } },
    artifacts: [
      { id: 'spec', phase: 'P1', path: 'spec.md', status: 'fresh', sources: [], hash: 'h0', stamp: 'APPROVED' },
      { id: 'task-3', phase: 'P4', path: 'plan.md#task-3', status: 'fresh',
        sources: [{ ref: 'spec#sec-storage', provenance: 'authored' }], hash: 'h1' },
      { id: 'test-3', phase: 'P5', path: 'test/foo.test.js', status: 'fresh',
        sources: [{ ref: 'task-3', provenance: 'authored' }], hash: 'h2' },
      { id: 'code-foo', phase: 'P5', path: 'src/foo.js', status: 'fresh',
        sources: [{ ref: 'test-3', provenance: 'inferred' }], hash: 'h3' },
    ],
  };
}
```

- [ ] **Step 4: Run the (empty) suite to confirm wiring**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS (0 tests, "tests 0").

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "chore: scaffold flow-change-protocol skill + test harness"
```

---

## Task 1: Pure helpers (`phaseIndex`, `resolveRef`, `findArtifact`, `isTombstone`, `hashContent`)

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `flow-change.test.js`:

```js
test('phaseIndex orders phases; resolveRef splits owner#section', () => {
  const s = fixture();
  assert.equal(fc.phaseIndex(s, 'P1') < fc.phaseIndex(s, 'P4'), true);
  assert.deepEqual(fc.resolveRef('spec#sec-storage'), { owner: 'spec', section: 'sec-storage' });
  assert.deepEqual(fc.resolveRef('task-3'), { owner: 'task-3', section: null });
});

test('findArtifact + isTombstone read state', () => {
  const s = fixture();
  s.artifacts.push({ id: 'task-7', status: 'tombstone', path: 'plan.md#task-7', sources: [] });
  s.sections['sec-old'] = { display: '(removed)', status: 'tombstone', alias: 'sec-storage' };
  assert.equal(fc.findArtifact(s, 'task-3').phase, 'P4');
  assert.equal(fc.isTombstone(s, 'task-7'), true);          // artifact tombstone
  assert.equal(fc.isTombstone(s, 'spec#sec-old'), true);     // section tombstone
  assert.equal(fc.isTombstone(s, 'spec#sec-storage'), false);
  assert.equal(fc.hashContent('abc'), fc.hashContent('abc'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL ("fc.phaseIndex is not a function").

- [ ] **Step 3: Implement the helpers**

Append to `flow-change.mjs`:

```js
export const phaseIndex = (state, phase) => state.phases.indexOf(phase);

export function resolveRef(ref) {
  const i = ref.indexOf('#');
  return i === -1 ? { owner: ref, section: null } : { owner: ref.slice(0, i), section: ref.slice(i + 1) };
}

export const findArtifact = (state, id) => state.artifacts.find((a) => a.id === id) || null;

export function isTombstone(state, ref) {
  const { owner, section } = resolveRef(ref);
  if (section) return state.sections[section]?.status === 'tombstone';
  return findArtifact(state, owner)?.status === 'tombstone';
}

export const hashContent = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): pure ref/phase/tombstone/hash helpers"
```

---

## Task 2: `classify` — typed operations + cut-depth + reject rules

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

Contract (spec §3.3): `classify(state, op) → { cutDepth, changedRefs, changedArtifacts, rejected? }`. A `spec#sec-*` change yields the owning `spec` artifact in `changedArtifacts`. Rejected only when the op would create/retain an edge **to** a tombstone (ADD/RE-EDGE whose newSources name a tombstone), or ADD without placement.

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('classify MODIFY of a section returns owning artifact + cutDepth', () => {
  const s = fixture();
  const r = fc.classify(s, { type: 'MODIFY', ref: 'spec#sec-storage' });
  assert.equal(r.rejected, undefined);
  assert.deepEqual(r.changedRefs, ['spec#sec-storage']);
  assert.deepEqual(r.changedArtifacts.sort(), ['spec']);
  assert.equal(r.cutDepth, 'P1');
});

test('classify RE-EDGE onto a tombstone is rejected; onto live is accepted', () => {
  const s = fixture();
  s.artifacts.push({ id: 'task-7', status: 'tombstone', path: 'p', sources: [] });
  const bad = fc.classify(s, { type: 'RE-EDGE', artifact: 'test-3', newSources: [{ ref: 'task-7', provenance: 'authored' }] });
  assert.equal(bad.rejected, 'edge-to-tombstone');
  const ok = fc.classify(s, { type: 'RE-EDGE', artifact: 'test-3', newSources: [{ ref: 'task-3', provenance: 'authored' }] });
  assert.equal(ok.rejected, undefined);
  assert.equal(ok.cutDepth, 'P5'); // test-3 lives at P5
});

test('classify ADD without phase/sources is rejected', () => {
  const s = fixture();
  assert.equal(fc.classify(s, { type: 'ADD', node: { id: 'x' } }).rejected, 'add-missing-placement');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL ("fc.classify is not a function").

- [ ] **Step 3: Implement `classify`**

Append:

```js
// owning artifact of a ref: "spec#sec-x" -> "spec"; "task-3" -> "task-3"
const owningArtifact = (ref) => resolveRef(ref).owner;
const earliestPhase = (state, ids) =>
  ids.map((id) => findArtifact(state, id)?.phase).filter(Boolean)
     .sort((a, b) => phaseIndex(state, a) - phaseIndex(state, b))[0] ?? null;

export function classify(state, op) {
  switch (op.type) {
    case 'MODIFY': {
      const changedRefs = [op.ref];
      const changedArtifacts = [owningArtifact(op.ref)];
      return { cutDepth: earliestPhase(state, changedArtifacts), changedRefs, changedArtifacts };
    }
    case 'RE-EDGE': {
      const bad = (op.newSources || []).some((e) => isTombstone(state, e.ref));
      if (bad) return { rejected: 'edge-to-tombstone' };
      return { cutDepth: findArtifact(state, op.artifact)?.phase ?? null,
               changedRefs: [op.artifact], changedArtifacts: [op.artifact] };
    }
    case 'ADD': {
      if (!op.node?.phase || !op.sources) return { rejected: 'add-missing-placement' };
      if (op.sources.some((e) => isTombstone(state, e.ref))) return { rejected: 'edge-to-tombstone' };
      return { cutDepth: op.node.phase, changedRefs: [op.node.id], changedArtifacts: [op.node.id] };
    }
    case 'DELETE': {
      const id = owningArtifact(op.ref);
      return { cutDepth: findArtifact(state, id)?.phase ?? null, changedRefs: [op.ref], changedArtifacts: [id] };
    }
    default:
      return { rejected: 'unknown-op' };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): classify typed ops + cut-depth + tombstone/ADD reject rules"
```

---

## Task 3: `blastRadius` — DAG closure + fail-closed + tombstone branch + acyclicity

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

Contract (spec §3.3/§3.3.1): `blastRadius(state, changedArtifacts, changedRefs) → staleIds`, where
`staleIds = changedArtifacts ∪ downstream(changedArtifacts ∪ changedRefs) ∪ failClosed`.
An edge matches a changed section ref precisely (`ref === 'spec#sec-x'`) or via a whole-owner edge (`ref === 'spec'`). Fail-closed adds any artifact at/after cut-depth with an untrusted edge OR an edge whose ref resolves to a tombstone (regardless of provenance). A cycle in the artifact DAG is a hard error.

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('blastRadius is section-precise and transitive', () => {
  const s = fixture();
  const stale = fc.blastRadius(s, ['spec'], ['spec#sec-storage']).sort();
  assert.deepEqual(stale, ['code-foo', 'spec', 'task-3', 'test-3']); // spec + full chain
});

test('blastRadius does NOT mark siblings not sourced from the changed section', () => {
  const s = fixture();
  s.artifacts.push({ id: 'task-9', phase: 'P4', path: 'p', status: 'fresh',
    sources: [{ ref: 'spec#sec-other', provenance: 'authored' }], hash: 'h' });
  s.sections['sec-other'] = { display: '§2.3', status: 'live', alias: null };
  const stale = fc.blastRadius(s, ['spec'], ['spec#sec-storage']);
  assert.equal(stale.includes('task-9'), false); // surgical: sourced from a different section
});

test('fail-closed: tombstone-target edge stales the owner regardless of provenance', () => {
  const s = fixture();
  s.artifacts.push({ id: 'task-7', status: 'tombstone', path: 'p', sources: [] });
  s.artifacts.push({ id: 'test-7', phase: 'P5', path: 'p', status: 'fresh',
    sources: [{ ref: 'task-7', provenance: 'authored' }], hash: 'h' }); // authored edge to a tombstone
  const stale = fc.blastRadius(s, ['spec'], ['spec#sec-storage']);
  assert.equal(stale.includes('test-7'), true);
});

test('blastRadius throws on a cycle', () => {
  const s = fixture();
  fc.findArtifact(s, 'spec').sources = [{ ref: 'code-foo', provenance: 'authored' }]; // spec<-...<-code-foo<-spec
  assert.throws(() => fc.blastRadius(s, ['spec'], []), /cycle/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL ("fc.blastRadius is not a function").

- [ ] **Step 3: Implement `blastRadius` (+ private `assertAcyclic`, `edgeMatches`)**

Append:

```js
// does artifact A's edge `e` depend on a changed seed (artifact id or section ref)?
function edgeMatches(e, seedArtifacts, seedRefs) {
  if (seedArtifacts.includes(e.ref)) return true;               // edge to a changed artifact id
  if (seedRefs.includes(e.ref)) return true;                    // precise section ref match
  const { owner, section } = resolveRef(e.ref);
  if (!section && seedRefs.some((r) => resolveRef(r).owner === owner)) return true; // whole-owner edge
  return false;
}

function assertAcyclic(state) {
  const color = new Map(); // 0=unvisited,1=in-stack,2=done
  const edgesOf = (id) => (findArtifact(state, id)?.sources || []).map((e) => owningArtifact(e.ref));
  const visit = (id) => {
    if (color.get(id) === 1) throw new Error(`cycle detected at ${id}`);
    if (color.get(id) === 2) return;
    color.set(id, 1);
    for (const nxt of edgesOf(id)) if (findArtifact(state, nxt)) visit(nxt);
    color.set(id, 2);
  };
  for (const a of state.artifacts) if (a.status !== 'tombstone') visit(a.id);
}

const isUntrusted = (e) => e.provenance !== 'authored' && !e.confirmed_at;

export function blastRadius(state, changedArtifacts, changedRefs = []) {
  assertAcyclic(state);
  const stale = new Set(changedArtifacts);
  // transitive downstream closure
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of state.artifacts) {
      if (a.status === 'tombstone' || stale.has(a.id)) continue;
      const seedArtifacts = [...stale, ...changedArtifacts];
      if ((a.sources || []).some((e) => edgeMatches(e, seedArtifacts, changedRefs))) {
        stale.add(a.id); grew = true;
      }
    }
  }
  // fail-closed: untrusted OR tombstone-target edges, for artifacts at/after cut-depth
  const cutIdx = Math.min(...changedArtifacts.map((id) => phaseIndex(state, findArtifact(state, id)?.phase)).filter((n) => n >= 0));
  for (const a of state.artifacts) {
    if (a.status === 'tombstone' || stale.has(a.id) || a.phase == null) continue;
    if (phaseIndex(state, a.phase) < cutIdx) continue;
    const risky = (a.sources || []).some((e) => isUntrusted(e) || isTombstone(state, e.ref));
    if (risky) stale.add(a.id);
  }
  return [...stale];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): blastRadius DAG closure + fail-closed + tombstone branch + acyclicity"
```

---

## Task 4: `markStale` — set stale, authoritative phase, clear spec stamp ≤P2

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

Contract (spec §3.3): set `staleIds` stale; `authoritative_phase ← cutDepth`; if the `spec` artifact is stale, clear its stamp AND clamp `authoritative_phase` no later than P2. Pure (returns a new state; does not mutate input).

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('markStale clamps to P2 and clears the spec stamp when spec is stale', () => {
  const s = fixture();
  const out = fc.markStale(s, ['spec', 'task-3', 'test-3', 'code-foo'], 'P1');
  assert.equal(out.authoritative_phase, 'P2'); // clamped no later than P2
  assert.equal(fc.findArtifact(out, 'spec').stamp, null);
  assert.equal(fc.findArtifact(out, 'task-3').status, 'stale');
  assert.equal(fc.findArtifact(s, 'task-3').status, 'fresh'); // input untouched (pure)
});

test('markStale without spec keeps cutDepth and leaves stamp', () => {
  const s = fixture();
  const out = fc.markStale(s, ['test-3', 'code-foo'], 'P5');
  assert.equal(out.authoritative_phase, 'P5');
  assert.equal(fc.findArtifact(out, 'spec').stamp, 'APPROVED');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL.

- [ ] **Step 3: Implement `markStale`**

Append:

```js
const clone = (state) => JSON.parse(JSON.stringify(state));

export function markStale(state, staleIds, cutDepth) {
  const out = clone(state);
  const set = new Set(staleIds);
  for (const a of out.artifacts) if (set.has(a.id) && a.status !== 'tombstone') a.status = 'stale';
  let phase = cutDepth;
  const spec = findArtifact(out, 'spec');
  if (spec && set.has('spec')) {
    spec.stamp = null;
    if (phaseIndex(out, phase) > phaseIndex(out, 'P2')) phase = 'P2';
  }
  out.authoritative_phase = phase;
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): markStale sets stale + clamps authoritative phase + clears spec stamp"
```

---

## Task 5: `nextWork` — topological order over the DAG

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

Contract (spec §3.3): return the next stale artifact to regenerate, earliest phase first; among equal phases, an artifact whose own sources are all fresh comes first (never regenerate against stale upstream). `null` when nothing is stale.

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('nextWork returns earliest-phase stale artifact with fresh upstream first', () => {
  let s = fc.markStale(fixture(), ['spec', 'task-3', 'test-3', 'code-foo'], 'P1');
  assert.equal(fc.nextWork(s).artifact, 'spec');         // P1 first
  s = fc.reconcileForTest(s, 'spec');                    // helper defined in Task 6; until then inline
  assert.equal(fc.nextWork(s).artifact, 'task-3');       // then P4, upstream now fresh
});

test('nextWork is null when all fresh', () => {
  assert.equal(fc.nextWork(fixture()), null);
});
```

> NOTE: the first test references `fc.reconcileForTest`. To keep Task 5 self-contained, replace that line with an inline mutation until Task 6 lands:
> `s = fc.markStale(s, [], s.authoritative_phase); fc.findArtifact(s,'spec').status='fresh';`
> Then in Task 6 you may switch it to the real `reconcile`.

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL ("fc.nextWork is not a function").

- [ ] **Step 3: Implement `nextWork`**

Append:

```js
const upstreamAllFresh = (state, a) =>
  (a.sources || []).every((e) => {
    const up = findArtifact(state, owningArtifact(e.ref));
    return !up || up.status === 'fresh';
  });

export function nextWork(state) {
  const stale = state.artifacts.filter((a) => a.status === 'stale');
  if (stale.length === 0) return null;
  stale.sort((a, b) => phaseIndex(state, a.phase) - phaseIndex(state, b.phase));
  const ready = stale.find((a) => upstreamAllFresh(state, a)) || stale[0];
  return { artifact: ready.id, phase: ready.phase };
}
```

- [ ] **Step 4: Run to verify pass** (with the inline mutation from the NOTE)

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): nextWork topological order (fresh-upstream-first)"
```

---

## Task 6: `reconcile` — mark fresh, record hash, stamp, reject hash mismatch

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

Contract (spec §3.3): `reconcile(state, artifactId, newHash, newStamp?) → newState`. Mark the artifact fresh, record `newHash`, set `stamp` if given. Throw if the artifact's on-disk hash ≠ `newHash` — caller passes the freshly computed disk hash, so a mismatch means a concurrent edit (here we just verify the arg vs. the value the caller claims by passing both equal in the happy path; mismatch is simulated by passing a different `expectedDiskHash`).

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('reconcile marks fresh + records hash + optional stamp', () => {
  let s = fc.markStale(fixture(), ['spec'], 'P1');
  s = fc.reconcile(s, 'spec', 'sha256:new', { diskHash: 'sha256:new', stamp: 'codex R1 APPROVED' });
  assert.equal(fc.findArtifact(s, 'spec').status, 'fresh');
  assert.equal(fc.findArtifact(s, 'spec').hash, 'sha256:new');
  assert.equal(fc.findArtifact(s, 'spec').stamp, 'codex R1 APPROVED');
});

test('reconcile rejects when disk hash disagrees with the recorded hash', () => {
  let s = fc.markStale(fixture(), ['spec'], 'P1');
  assert.throws(() => fc.reconcile(s, 'spec', 'sha256:a', { diskHash: 'sha256:b' }), /hash mismatch/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL.

- [ ] **Step 3: Implement `reconcile`** (and replace the Task 5 inline helper with the real call if you stubbed `reconcileForTest`)

Append:

```js
export function reconcile(state, artifactId, newHash, opts = {}) {
  if (opts.diskHash != null && opts.diskHash !== newHash) {
    throw new Error(`hash mismatch for ${artifactId}: disk ${opts.diskHash} ≠ expected ${newHash}`);
  }
  const out = clone(state);
  const a = findArtifact(out, artifactId);
  if (!a) throw new Error(`unknown artifact ${artifactId}`);
  a.status = 'fresh';
  a.hash = newHash;
  if (opts.stamp) a.stamp = opts.stamp;
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): reconcile marks fresh + hash record + mismatch rejection"
```

---

## Task 7: `checkDrift` — schema version, base SHA, content hashes

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

Contract (spec §5): `checkDrift(state, { readFile, headSha }) → { schemaOk, headOk, drifted[] }`. `drifted` lists artifacts whose on-disk content hash ≠ recorded `hash`. `readFile(path)` and `headSha()` are injected so the function stays pure/testable (no real fs/git in tests).

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('checkDrift flags schema, HEAD, and content mismatches', () => {
  const s = fixture();
  s.schema_version = 1; s.base_sha = 'abc';
  const readFile = (p) => (p === 'plan.md#task-3' ? 'CHANGED' : 'same');
  // recorded hashes: set spec/test/code to match "same", task-3 recorded stale-on-disk
  for (const a of s.artifacts) a.hash = fc.hashContent('same');
  const res = fc.checkDrift(s, { readFile, headSha: () => 'abc' });
  assert.equal(res.schemaOk, true);
  assert.equal(res.headOk, true);
  assert.deepEqual(res.drifted, ['task-3']); // its disk content "CHANGED" ≠ recorded
});

test('checkDrift reports schema + HEAD divergence', () => {
  const s = fixture(); s.schema_version = 0; s.base_sha = 'old';
  const res = fc.checkDrift(s, { readFile: () => '', headSha: () => 'new' });
  assert.equal(res.schemaOk, false);
  assert.equal(res.headOk, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL.

- [ ] **Step 3: Implement `checkDrift`**

Append:

```js
export function checkDrift(state, { readFile, headSha }) {
  const drifted = [];
  for (const a of state.artifacts) {
    if (a.status === 'tombstone' || !a.path || a.hash == null) continue;
    let disk;
    try { disk = hashContent(readFile(a.path)); } catch { drifted.push(a.id); continue; }
    if (disk !== a.hash) drifted.push(a.id);
  }
  return {
    schemaOk: state.schema_version === SCHEMA_VERSION,
    headOk: state.base_sha == null || state.base_sha === headSha(),
    drifted,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): checkDrift (schema + HEAD + content-hash) with injected fs/git"
```

---

## Task 8: CLI wrapper

**Files:**
- Modify: `~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs`
- Test: `~/.claude/skills/flow-change-protocol/scripts/flow-change.test.js`

The CLI is the thin impure shell the SKILL.md calls: `classify`, `plan` (classify+blastRadius preview), `apply` (markStale → write state), `next`, `drift`. It reads/writes a `flow-state.json` path and prints JSON. Keep logic in the pure functions; the CLI only does fs + git + JSON.

- [ ] **Step 1: Write the failing test (the `plan` preview is pure-composable)**

Append:

```js
test('planPreview composes classify + blastRadius for the gate display', () => {
  const s = fixture();
  const p = fc.planPreview(s, { type: 'MODIFY', ref: 'spec#sec-storage' });
  assert.equal(p.cutDepth, 'P1');
  assert.deepEqual(p.staleIds.sort(), ['code-foo', 'spec', 'task-3', 'test-3']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: FAIL.

- [ ] **Step 3: Implement `planPreview` + the CLI dispatcher**

Append:

```js
export function planPreview(state, op) {
  const c = classify(state, op);
  if (c.rejected) return { rejected: c.rejected };
  const staleIds = blastRadius(state, c.changedArtifacts, c.changedRefs);
  return { cutDepth: c.cutDepth, changedArtifacts: c.changedArtifacts, staleIds };
}

// ---- CLI (impure shell) ----
import { readFileSync as _read, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const headSha = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(); } catch { return null; } };

function cli(argv) {
  const [cmd, statePath, opJson] = argv;
  const load = () => JSON.parse(_read(statePath, 'utf8'));
  const save = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n');
  const op = opJson ? JSON.parse(opJson) : null;
  switch (cmd) {
    case 'plan':   return console.log(JSON.stringify(planPreview(load(), op), null, 2));
    case 'apply': {
      const s = load(); const p = planPreview(s, op);
      if (p.rejected) { console.error('rejected: ' + p.rejected); process.exit(2); }
      save(markStale(s, p.staleIds, p.cutDepth)); return console.log('applied; authoritative=' + p.cutDepth);
    }
    case 'next':   return console.log(JSON.stringify(nextWork(load())));
    case 'drift':  return console.log(JSON.stringify(checkDrift(load(), { readFile: (p) => _read(p, 'utf8'), headSha }), null, 2));
    default:       console.error('usage: flow-change <plan|apply|next|drift> <flow-state.json> [opJson]'); process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('flow-change.mjs')) cli(process.argv.slice(2));
```

- [ ] **Step 4: Run to verify pass + smoke-test the CLI**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS.

Smoke:
```bash
cd /tmp && node -e "require('fs').writeFileSync('fs.json', JSON.stringify({schema_version:1,base_sha:null,authoritative_phase:'P5',phases:['P0','P1','P2','P3','P4','P5'],sections:{'sec-storage':{display:'§2.2',status:'live',alias:null}},artifacts:[{id:'spec',phase:'P1',path:'s',status:'fresh',sources:[],hash:'h'},{id:'task-3',phase:'P4',path:'t',status:'fresh',sources:[{ref:'spec#sec-storage',provenance:'authored'}],hash:'h'}]}))"
node ~/.claude/skills/flow-change-protocol/scripts/flow-change.mjs plan /tmp/fs.json '{"type":"MODIFY","ref":"spec#sec-storage"}'
```
Expected: JSON with `cutDepth: "P1"` and `staleIds` containing `spec` and `task-3`.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "feat(engine): planPreview + CLI (plan/apply/next/drift)"
```

---

## Task 9: `references/flow-state-schema.md`

**Files:**
- Create: `~/.claude/skills/flow-change-protocol/references/flow-state-schema.md`

- [ ] **Step 1: Write the schema reference**

Create the file documenting every `flow-state.json` field exactly as in spec §3.1: `schema_version`, `base_sha`, `authoritative_phase`, `phases`, `sections` (`display`/`status`/`alias`), and `artifacts` (`id`/`phase`/`path`/`status` ∈ {fresh,stale,tombstone}/`sources` as edge objects `{ref,provenance,rationale?,confirmed_at?}`/`hash`/`stamp?`/`alias?`). Include the two-graph explanation (artifact DAG vs control-flow back-edges) and the worked `spec#sec-storage` example from the spec. Include a "ref grammar" line: `ref = <artifact-id> | <artifact-id>#<section-id>`.

- [ ] **Step 2: Verify it matches the engine**

Run: `grep -o 'provenance\|confirmed_at\|schema_version\|tombstone' ~/.claude/skills/flow-change-protocol/references/flow-state-schema.md | sort -u`
Expected: all four field names present.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "docs(skill): flow-state.json schema reference"
```

---

## Task 10: `references/bootstrap.md`

**Files:**
- Create: `~/.claude/skills/flow-change-protocol/references/bootstrap.md`

- [ ] **Step 1: Write the bootstrap guide**

Create the file capturing spec §6: scan existing artifacts; parse a writing-plans plan's "Self-Review / Spec coverage" section into candidate `sources` (`Task N → spec §X`), inferred test/code edges from each Task's prose; every inferred edge stored `provenance: "inferred"` + a short rationale; **present the inferred graph for user confirmation before first use** (`inferred → authored` on confirm); an unconfirmed `inferred` edge is untrusted → fail-closed (§3.3.1), so a wrong inference can only cause extra review, never silent false precision; bootstrap is one-time. Include the exact shell to compute initial hashes: `git rev-parse --short HEAD` for `base_sha` and a sha256 per artifact path.

- [ ] **Step 2: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "docs(skill): bootstrap guide for existing projects"
```

---

## Task 11: `SKILL.md` — trigger + 4-step flow + the confirm-blast-radius gate

**Files:**
- Create: `~/.claude/skills/flow-change-protocol/SKILL.md`

- [ ] **Step 1: Write the frontmatter (pushy description for triggering)**

```markdown
---
name: flow-change-protocol
description: >-
  Handle a design change or rollback AFTER a spec is finalized, deterministically
  instead of chaotically. Use whenever, in a project that already has a
  flow-state.json, the user wants to "change the design", "roll back X", "actually
  Y should be Z", "scrap that approach", or otherwise alter a spec/plan/code that
  was already settled — so downstream plan/tests/code don't silently go
  inconsistent. Classifies the change (cut-depth), shows the exact blast radius for
  confirmation, marks only the affected artifacts stale, and drives ordered
  regeneration with the P2/codex gates. Do NOT use for greenfield work with no spec
  yet, or for a brand-new feature (that's brainstorming → the normal flow).
---
```

- [ ] **Step 2: Write the body — the 4-step flow**

Write the body from spec §4: trigger; Step 1 locate `flow-state.json` (missing → bootstrap, §references/bootstrap.md) and run `flow-change.mjs drift` first; Step 2 capture the change as a TYPED op (MODIFY/ADD/DELETE/RE-EDGE — ADD/RE-EDGE need explicit placement); Step 3 **★ the confirm-blast-radius gate** — run `flow-change.mjs plan` and show the user cut-depth + the exact `staleIds` + that a stale spec must re-pass P2 + incremental codex; confirm/narrow/cancel; Step 4 `flow-change.mjs apply`; Step 5 regenerate in `flow-change.mjs next` order with the P2 design-approval gate, P3 incremental `codex-spec-review` (APPROVED→P4 | ROLLBACK_TO_BRAINSTORMING→P1), then P4/P5 TDD; Step 6 `reconcile` each (record new hash) until all fresh. Include the **two hard rules** (the step-3 gate is never skipped; `next` order is never violated) and the **drift / cycle / tombstone** handling from §5. Point to `scripts/flow-change.mjs` for every computation and to `references/` for schema + bootstrap.

- [ ] **Step 3: Verify the skill loads (frontmatter parses)**

Run: `head -20 ~/.claude/skills/flow-change-protocol/SKILL.md`
Expected: valid YAML frontmatter with `name: flow-change-protocol`.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "docs(skill): SKILL.md — trigger + 4-step flow + confirm-blast-radius gate"
```

---

## Task 12: Full-suite green + self-review

**Files:**
- Verify only.

- [ ] **Step 1: Run the whole engine suite**

Run: `cd ~/.claude/skills/flow-change-protocol && node --test scripts/`
Expected: PASS — all tests from Tasks 1–8 green.

- [ ] **Step 2: Confirm the tree**

Run: `find ~/.claude/skills/flow-change-protocol -type f -not -path '*/.git/*' | sort`
Expected: SKILL.md, scripts/flow-change.mjs, scripts/flow-change.test.js, references/flow-state-schema.md, references/bootstrap.md.

- [ ] **Step 3: Self-review against the spec §7 test list**

Confirm a test exists for each §7 case: cut-depth earliest (Task 2); each op type + ADD-without-placement reject (Task 2); section-precise transitive closure (Task 3); acyclicity rejects a seeded cycle (Task 3); fail-closed for untrusted/tombstone edges, no over/under-mark (Task 3); nextWork topological order (Task 5); reconcile close-out + hash-mismatch rejection (Task 6); drift on a hand-edited fixture (Task 7). List any gap and add the test.

- [ ] **Step 4: Final commit**

```bash
cd ~/.claude/skills/flow-change-protocol && git add -A && git commit -q -m "test: full flow-change engine suite green (spec §7 coverage)"
```

---

## Self-Review

**Spec coverage (§3 components → tasks):**
- `flow-change.mjs` pure engine (classify/blastRadius/markStale/nextWork/reconcile) → Tasks 2–6. ✓
- typed ops MODIFY/ADD/DELETE/RE-EDGE → Task 2. ✓
- per-edge provenance + fail-closed degradation incl. provenance-independent tombstone branch → Task 3. ✓
- acyclic-DAG validation → Task 3. ✓
- drift detection (schema_version + base_sha + content hash) → Task 7. ✓
- CLI shell → Task 8. ✓
- `flow-change.test.js` (§7 cases) → Tasks 1–8 + Task 12 audit. ✓
- `references/flow-state-schema.md`, `references/bootstrap.md` → Tasks 9–10. ✓
- SKILL.md (trigger + 4-step flow + confirm-blast-radius gate) → Task 11. ✓
- P2 gate + P3 supervisor outcomes (APPROVED→P4 | ROLLBACK→P1) → Task 11 body + Task 4 markStale clamp. ✓
- single git-tracked `flow-state.json` lives in the target project (not the skill dir) → documented in Task 9/10/11. ✓

**Placeholder scan:** none — every code step shows complete code; Task 9/10/11 are prose-doc tasks whose content is fully specified by reference to exact spec sections.

**Type consistency:** state shape and the edge-object `{ref, provenance, rationale?, confirmed_at?}` are identical across the fixture (Task 0), `classify`/`blastRadius` (Tasks 2–3), `markStale`/`reconcile` (Tasks 4,6), and `checkDrift` (Task 7). `planPreview` returns `{cutDepth, changedArtifacts, staleIds}` consumed identically by the CLI `plan`/`apply` (Task 8) and the SKILL.md gate (Task 11). Op shapes (`MODIFY/ADD/DELETE/RE-EDGE`) are identical in Task 2 and Task 11.

**Known gap (carried from the review):** the R5 §3.3.1 tombstone-branch fix is covered by a Task 3 test (`authored edge to a tombstone`), closing the lone un-re-reviewed residual at implementation time.
