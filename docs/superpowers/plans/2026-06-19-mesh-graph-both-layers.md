# Mesh Graph — Both Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the dashboard's delegation graph as two distinct layers — faint dashed A2A peer wires (capability) plus a teal observed-traffic overlay driven by live activity.

**Architecture:** A new pure module `graph-observed.js` exports `reconcileObserved(prevKeys, edges)` returning `{add, update, remove}` — unit-tested with `node --test`. The browser module `graph-view.js` imports it as the thin impure shell: it filters activity edges to known nodes, calls `reconcileObserved`, and applies the diff to a new `gObs` SVG group (create/remove `<path class="oedge">`, toggle `.active`). CSS restyles peer wires faint/dashed and adds the teal observed-edge styling, legend, and teal pulse recolor. No backend, route, or `activity.js` change.

**Tech Stack:** Vanilla ES modules, SVG, `node --test` (zero deps), CSS. Node ≥ 20.

---

## Background the implementer needs

- **Repo conventions:** zero runtime dependencies; tests are `node --test` files under `test/`; run the full suite with `npm test`, one file with `node --test test/<file>.js`. ES modules everywhere (`import`/`export`). Node ≥ 20.
- **The graph lives in** `src/dashboard/public/graph-view.js` (browser ES module, no DOM test harness today) and `src/dashboard/public/graph-view.css`. It is verified live via the running dashboard, NOT unit tests — which is exactly why this plan extracts the pure decision (`reconcileObserved`) into its own module so it CAN be unit-tested without a DOM.
- **Activity data shape** (`/api/activity`, produced by `src/dashboard/activity.js` `buildActivity`): `{ agents:[{name,state,route}], edges:[{from,to,active,kind}], events:[...] }`. `edges` already drops `from===to` and includes both active and recently-done edges within the activity window. We do NOT modify this.
- **Mesh data shape** (`/api/mesh`): `{ agents:[{name, peers:[...]}] }`. Drives the static capability wires.
- **Existing graph internals** (`graph-view.js`):
  - `let agents=[], byName={}, nodeEls={}, peerEls=[], field=null, gArc=null;` (≈L15)
  - `ensureGraph()` (≈L156–183): fetches `/api/mesh`, builds `agents`/`byName`/`peerEls`, creates SVG groups `gPeer, ga(→gArc), gNode`, then `layout()`.
  - `curve(a,b)` (≈L185): returns an SVG path `d` string between two node `{x,y}` objects.
  - `layout()` (≈L186–192): positions nodes on a circle, sets each `peerEls` `d`.
  - `travel(a,b)` (≈L194–200): guarded `if (!byName[a] || !byName[b]) return;`, animates a dot along `curve()`.
  - `loadActivity()` (≈L202–226): fetches `/api/activity`, toggles `.work` on nodes, and currently `for (const e of (act.edges||[])) if (e.active) travel(e.from, e.to);` — we replace that one loop.
  - `mk(tag, attrs)` (≈L8): namespaced SVG element factory.
- **CSS facts** (`graph-view.css`): everything is scoped under `#view-graph`. Current `.peer{stroke:#d4ccba;stroke-width:1.4;fill:none}` (L79), `.arc{...stroke:var(--amber)...}` (L80), `.gpulse{fill:var(--amber)}` (L81). Theme vars (board2.css): `--teal2:#14b8a6`, `--ink2:#5d7a73`, `--mono` (monospace font), `--line:#e2dccd`.
- **The graph section header** in `TEMPLATE` (≈L72):
  `<div class="shead" data-fold><span class="caret">▾</span><span>◉ LIVE DELEGATION GRAPH</span><span class="live-ind">● live</span><span class="meta" id="gv-agc">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>`
  The fold handler (≈L106) ignores clicks on `.ranges`/`.maxbtn`; our legend has no click handler, so a click on it bubbles to fold — acceptable, but the legend must be inert (no buttons).

---

## File Structure

- **Create** `src/dashboard/public/graph-observed.js` — pure `reconcileObserved(prevKeys, edges)`. One responsibility: set-diff the previous observed-edge keys against the new edge list. No DOM, no fetch, browser+node importable.
- **Create** `test/graph-observed.test.js` — `node --test` unit tests for `reconcileObserved`.
- **Modify** `src/dashboard/public/graph-view.js` — import `reconcileObserved`; add `gObs` group + `oedges` map; apply the diff in `loadActivity`; re-path observed edges in `layout`; add legend span to `TEMPLATE`.
- **Modify** `src/dashboard/public/graph-view.css` — restyle `.peer` faint/dashed; add `.oedge`/`.oedge.active`; recolor `.arc`/`.gpulse` teal; add `.gv-legend`.

---

## Task 1: Pure `reconcileObserved` module + tests

**Files:**
- Create: `src/dashboard/public/graph-observed.js`
- Test: `test/graph-observed.test.js`

The reconcile function takes the set of currently-rendered edge keys (`prevKeys`, an array of `"from|to"` strings) and the new list of edges to show (`edges`, already filtered to known nodes by the caller). It returns three lists describing the minimal DOM change:
- `add`: edges present now but not before → `[{from,to,active}]`
- `update`: edges present before AND now → `[{key,active}]` (so the caller re-syncs the `.active` class even if it didn't change — idempotent and cheap)
- `remove`: keys present before but not now → `["from|to"]`

Key format is `` `${from}|${to}` `` — identical to `buildActivity`'s edge keying, so directionality is preserved (`a|b` ≠ `b|a`).

- [ ] **Step 1: Write the failing test**

Create `test/graph-observed.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileObserved } from '../src/dashboard/public/graph-observed.js';

test('adds a brand-new observed edge', () => {
  const { add, update, remove } = reconcileObserved([], [{ from: 'a', to: 'b', active: true }]);
  assert.deepEqual(add, [{ from: 'a', to: 'b', active: true }]);
  assert.deepEqual(update, []);
  assert.deepEqual(remove, []);
});

test('updates an edge that persists across reconciles', () => {
  const { add, update, remove } = reconcileObserved(['a|b'], [{ from: 'a', to: 'b', active: false }]);
  assert.deepEqual(add, []);
  assert.deepEqual(update, [{ key: 'a|b', active: false }]);
  assert.deepEqual(remove, []);
});

test('removes an edge that aged out of the window', () => {
  const { add, update, remove } = reconcileObserved(['a|b'], []);
  assert.deepEqual(add, []);
  assert.deepEqual(update, []);
  assert.deepEqual(remove, ['a|b']);
});

test('directionality is preserved (a|b not equal to b|a)', () => {
  const { add, remove } = reconcileObserved(['a|b'], [{ from: 'b', to: 'a', active: true }]);
  assert.deepEqual(add, [{ from: 'b', to: 'a', active: true }]);
  assert.deepEqual(remove, ['a|b']);
});

test('mixed add/update/remove in one reconcile', () => {
  const prev = ['a|b', 'c|d'];
  const edges = [
    { from: 'a', to: 'b', active: true },   // update
    { from: 'e', to: 'f', active: false },  // add
  ];                                         // c|d → remove
  const { add, update, remove } = reconcileObserved(prev, edges);
  assert.deepEqual(add, [{ from: 'e', to: 'f', active: false }]);
  assert.deepEqual(update, [{ key: 'a|b', active: true }]);
  assert.deepEqual(remove, ['c|d']);
});

test('coerces active to boolean', () => {
  const { add, update } = reconcileObserved([], [{ from: 'a', to: 'b' }]);
  assert.equal(add[0].active, false);
  const r2 = reconcileObserved(['a|b'], [{ from: 'a', to: 'b', active: 1 }]);
  assert.equal(r2.update[0].active, true);
});

test('empty in, empty out', () => {
  assert.deepEqual(reconcileObserved([], []), { add: [], update: [], remove: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/graph-observed.test.js`
Expected: FAIL — `Cannot find module '.../graph-observed.js'` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/dashboard/public/graph-observed.js`:

```js
// src/dashboard/public/graph-observed.js
// PURE set-diff for the observed-traffic layer of the delegation graph.
// Given the keys of currently-rendered observed edges and the new edge list
// (already filtered to known nodes by the caller), returns the minimal DOM
// change: which edges to add, which to update (.active resync), which to remove.
// No DOM, no fetch — unit-testable in node, importable in the browser.
//
// Edge key = `${from}|${to}` (matches src/dashboard/activity.js keying, so
// directionality is preserved: a|b is distinct from b|a).

/**
 * @param {string[]} prevKeys           keys of edges currently in the DOM
 * @param {Array<{from:string,to:string,active?:any}>} edges  new edges to show
 * @returns {{add:Array<{from,to,active:boolean}>, update:Array<{key:string,active:boolean}>, remove:string[]}}
 */
export function reconcileObserved(prevKeys, edges) {
  const prev = new Set(prevKeys || []);
  const next = new Set();
  const add = [];
  const update = [];
  for (const e of edges || []) {
    const key = `${e.from}|${e.to}`;
    if (next.has(key)) continue;        // de-dupe defensively
    next.add(key);
    const active = !!e.active;
    if (prev.has(key)) update.push({ key, active });
    else add.push({ from: e.from, to: e.to, active });
  }
  const remove = [...prev].filter((k) => !next.has(k));
  return { add, update, remove };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/graph-observed.test.js`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/graph-observed.js test/graph-observed.test.js
git commit -m "feat(graph): pure reconcileObserved set-diff for observed layer"
```

---

## Task 2: Wire the observed layer into `graph-view.js`

**Files:**
- Modify: `src/dashboard/public/graph-view.js`

This task is browser SVG glue (no unit test — verified live in Task 4). It (a) imports `reconcileObserved`, (b) adds the `gObs` group + `oedges` map, (c) replaces the single `travel` loop in `loadActivity` with the reconcile+apply block, and (d) re-paths observed edges on resize in `layout`.

- [ ] **Step 1: Add the import**

At the top of `src/dashboard/public/graph-view.js`, next to the existing `import { agentColor } from '/board2-model.js';` (≈L5), add:

```js
import { reconcileObserved } from '/graph-observed.js';
```

(Browser absolute path — the dashboard serves `src/dashboard/public/` at the web root, same as `/board2-model.js`.)

- [ ] **Step 2: Declare `gObs` and the `oedges` map**

In the module-scoped `let` block (≈L15), add `gObs` and `oedges`. Change:

```js
let agents = [], byName = {}, nodeEls = {}, peerEls = [], field = null, gArc = null;
```

to:

```js
let agents = [], byName = {}, nodeEls = {}, peerEls = [], field = null, gArc = null, gObs = null;
let oedges = {};   // key `from|to` → { from, to, el }  (observed edges, persistent)
```

- [ ] **Step 3: Create the `gObs` group in `ensureGraph`**

In `ensureGraph()` (≈L168), change the group creation so `gObs` sits between the capability wires (`gPeer`) and the traveling pulse (`gArc`):

```js
const gPeer = mk('g'), ga = mk('g'), gNode = mk('g'); field.append(gPeer, ga, gNode); gArc = ga;
```

to:

```js
const gPeer = mk('g'), gob = mk('g'), ga = mk('g'), gNode = mk('g'); field.append(gPeer, gob, ga, gNode); gArc = ga; gObs = gob;
```

(Order in `append` = paint order: capability wires bottom, observed edges above them, traveling pulse above those, nodes on top.)

- [ ] **Step 4: Replace the active-edge loop in `loadActivity` with reconcile + apply**

In `loadActivity()` (≈L210), replace this single line:

```js
  for (const e of (act.edges || [])) if (e.active) travel(e.from, e.to);
```

with:

```js
  // Observed-traffic layer: persistent edges reconciled against the activity window.
  const known = (act.edges || []).filter((e) => byName[e.from] && byName[e.to]);
  const { add, update, remove } = reconcileObserved(Object.keys(oedges), known);
  for (const e of add) {
    const key = `${e.from}|${e.to}`;
    const el = gObs.appendChild(mk('path', { class: 'oedge' }));
    el.setAttribute('d', curve(byName[e.from], byName[e.to]));
    el.classList.toggle('active', !!e.active);
    oedges[key] = { from: e.from, to: e.to, el };
  }
  for (const u of update) oedges[u.key].el.classList.toggle('active', !!u.active);
  for (const key of remove) { oedges[key].el.remove(); delete oedges[key]; }
  // traveling pulse stays on every active edge (newly added OR already present)
  for (const e of known) if (e.active) travel(e.from, e.to);
```

- [ ] **Step 5: Re-path observed edges in `layout`**

In `layout()` (≈L191), after the existing peer-wire re-path line:

```js
  for (const p of peerEls) if (byName[p.u] && byName[p.v]) p.el.setAttribute('d', curve(byName[p.u], byName[p.v]));
```

add:

```js
  for (const key of Object.keys(oedges)) { const o = oedges[key]; if (byName[o.from] && byName[o.to]) o.el.setAttribute('d', curve(byName[o.from], byName[o.to])); }
```

- [ ] **Step 6: Add the legend to the graph section header in `TEMPLATE`**

In `TEMPLATE` (≈L72), in the `#sec-graph` header, insert the legend span right after the `<span class="live-ind">● live</span>`:

```html
    <div class="shead" data-fold><span class="caret">▾</span><span>◉ LIVE DELEGATION GRAPH</span><span class="live-ind">● live</span><span class="gv-legend"><i class="lg-cap"></i>can delegate<i class="lg-obs"></i>communicating</span><span class="meta" id="gv-agc">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>
```

- [ ] **Step 7: Run the full test suite (no regressions)**

Run: `npm test`
Expected: PASS — all existing tests plus Task 1's `graph-observed.test.js` pass. `graph-view.js` has no unit tests, so this only confirms nothing else broke and the new module still passes.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/public/graph-view.js
git commit -m "feat(graph): overlay observed-traffic layer via reconcileObserved"
```

---

## Task 3: Two-layer CSS — faint wires, teal observed edges, legend

**Files:**
- Modify: `src/dashboard/public/graph-view.css`

- [ ] **Step 1: Restyle the capability wires faint + dashed**

In `src/dashboard/public/graph-view.css`, replace line 79:

```css
#view-graph .peer{stroke:#d4ccba;stroke-width:1.4;fill:none}
```

with:

```css
#view-graph .peer{stroke:#cabfa3;stroke-width:1.3;stroke-dasharray:5 5;fill:none;opacity:.5}
```

- [ ] **Step 2: Recolor the traveling pulse teal**

Replace lines 80–81:

```css
#view-graph .arc{fill:none;stroke:var(--amber);stroke-width:2.6;stroke-dasharray:7 5;animation:dashmove .9s linear infinite}
#view-graph .gpulse{fill:var(--amber)}
```

with:

```css
#view-graph .arc{fill:none;stroke:var(--teal2);stroke-width:2.6;stroke-dasharray:7 5;animation:dashmove .9s linear infinite}
#view-graph .gpulse{fill:var(--teal2)}
```

- [ ] **Step 3: Add the observed-edge styles**

Immediately after the `.gpulse` line (now line 81), add:

```css
#view-graph .oedge{stroke:#bdb091;stroke-width:1.6;fill:none;opacity:.34;transition:stroke .35s,stroke-width .35s,opacity .5s}
#view-graph .oedge.active{stroke:var(--teal2);stroke-width:2.6;opacity:.95}
```

- [ ] **Step 4: Add the legend styles**

After the `.oedge.active` line, add:

```css
#view-graph .gv-legend{display:inline-flex;gap:12px;align-items:center;font:10px var(--mono);color:var(--ink2);margin-left:8px}
#view-graph .gv-legend i{display:inline-block;width:18px;height:0;vertical-align:middle;margin-right:4px}
#view-graph .gv-legend .lg-cap{border-top:1.4px dashed #cabfa3}
#view-graph .gv-legend .lg-obs{border-top:2.4px solid var(--teal2)}
```

- [ ] **Step 5: Verify CSS is well-formed (no syntax break)**

Run: `node -e "const c=require('fs').readFileSync('src/dashboard/public/graph-view.css','utf8'); const o=(c.match(/{/g)||[]).length, x=(c.match(/}/g)||[]).length; if(o!==x){console.error('brace mismatch',o,x);process.exit(1)} console.log('braces balanced:',o)"`
Expected: `braces balanced: <N>` (open == close, exit 0).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/public/graph-view.css
git commit -m "style(graph): faint dashed wires + teal observed layer + legend"
```

---

## Task 4: Live verification on the running dashboard

**Files:** none (manual verification per the spec's Verification section).

This is the runtime check the unit tests can't cover. Use the `verify` discipline: build/run the real surface and observe.

- [ ] **Step 1: Restart the dashboard** (server/static files changed — a stale instance serves old assets)

```bash
pkill -f 'agent-mesh.*dashboard' 2>/dev/null; sleep 1
# then start the dashboard the way this repo does (see how it's normally launched);
# open the Graph view in a browser.
```

- [ ] **Step 2: Confirm the capability layer** — peer wires render faint + dashed; the header legend shows a dashed "can delegate" swatch and a teal "communicating" swatch.

- [ ] **Step 3: Confirm the observed layer** — with live mesh activity (or a seeded run-log), an active delegation draws a teal edge + traveling teal pulse. Confirm at least one teal edge appears between two agents that have NO dashed wire between them (cross-plane traffic).

- [ ] **Step 4: Confirm aging** — after a delegation finishes and ages out of the activity window, its teal edge fades and is removed on the next `loadActivity`.

- [ ] **Step 5: Confirm controls still work** — fold and maximize (`⤢`) on the graph section behave as before with the legend present; resizing the panel re-paths both layers correctly.

- [ ] **Step 6: Capture evidence** — screenshot the both-layers graph showing a teal active edge over the faint dashed wires. Note any friction in the verification report.

---

## Self-Review notes (author)

- **Spec coverage:** capability restyle (T3 S1), observed overlay (T2 S4 + T1), gObs paint order (T2 S3), legend (T2 S6 + T3 S4), teal pulse recolor (T3 S2), layout re-path (T2 S5), pure/testable reconcile (T1), no backend change (none touched), live verification (T4). All spec sections mapped.
- **Type consistency:** `reconcileObserved(prevKeys, edges) → {add:[{from,to,active}], update:[{key,active}], remove:[key]}` used identically in T1 (def+tests) and T2 S4 (apply). `oedges` shape `{from,to,el}` consistent in T2 S3/S4/S5. Key format `` `${from}|${to}` `` consistent throughout.
- **No placeholders:** every code step shows complete code; commands have expected output.
