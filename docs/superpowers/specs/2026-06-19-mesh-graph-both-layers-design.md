# Mesh Graph — Capability + Observed Traffic ("Both Layers") Design

**Date:** 2026-06-19
**Status:** Approved (design); pending spec review
**Topic:** Dashboard "Graph" view — render the A2A peer wiring (capability) and the observed communication (traffic) as two distinguishable layers in one constellation.

## Problem

The dashboard's LIVE DELEGATION GRAPH (`src/dashboard/public/graph-view.js`,
`#sec-graph`) draws lines between agents from each agent's `registry.json`
`peers` list (`/api/mesh`). Those lines are styled identically to "live" and
read as *traffic*, but they are actually *capability* — who **can** delegate
over the A2A peer-bridge. Meanwhile real collaboration also flows over planes
that have **no** peer wire: the always-on daemon driving coder→reviewer, and
GitHub-mediated orchestration (CI workflows coordinating via labels/PRs). The
current graph therefore tells a misleading story: it shows static permissions
as if they were activity, and hides the cross-plane traffic that has no wire.

The user reported this directly: *"the links between agents are not accurate —
the agents can still talk to each other without wires connected."* After
clarifying that wires **do** matter (the A2A peer-bridge refuses any peer not in
the marker-validated `registry.json`), the agreed direction is **"Both
layers"**: keep the wires but render them as faint capability, and overlay the
observed traffic on top.

## Goal

One graph, two visually distinct layers:

1. **Capability layer** — the `/api/mesh` peer wires, rendered **faint +
   dashed** and labelled "A2A route — can delegate." Always present, low-key.
2. **Observed layer** — edges from `/api/activity` `edges[]`, **materialized
   as persistent lines** (not just transient pulses): **teal** when active
   (with the existing traveling-dot pulse), **faint** when recently-seen, and
   **removed** when they age out of the activity window. Drawn **whether or not
   a capability wire exists** between the two agents — so cross-plane
   collaboration becomes visible.

A legend distinguishes the two. No backend change: `/api/mesh` and
`/api/activity` already return everything needed.

## Non-Goals (YAGNI)

- **No new graph nodes.** Nodes remain exactly the `/api/mesh` agents. An
  observed edge whose `from`/`to` is not a known node is skipped (same guard as
  today's `travel()`), so no phantom "orchestrator" node is synthesized. The
  honest "traffic with no wire" case still appears whenever **both** endpoints
  are mesh agents but no peer wire connects them (e.g., a daemon-driven
  coder→reviewer where the wire runs the other direction or not at all).
- **No client-side fade timers.** Aging is data-driven: each `loadActivity`
  reconciles the observed-edge set against the current `act.edges`. An edge that
  drops out of the window is removed; CSS transitions handle the visual fade
  between active/faint/gone. (The activity window already includes recently-done
  edges, per `buildActivity`.)
- **No change to the events ticker, token panel, or any other `#sec-*`
  section.** This is scoped to the constellation SVG only.
- **No `/api/*` route or `src/dashboard/activity.js` change.**

## Current Behavior (what exists today)

`src/dashboard/public/graph-view.js`:

- `ensureGraph()` (≈L156–183): fetches `/api/mesh`, builds `names` and `pairs`
  (`[a.name, peer]` for every peer that is also a known agent), creates one
  SVG `<g>` per layer — `gPeer`, `ga`(→`gArc`), `gNode` — and
  `peerEls = pairs.map(([u,v]) => ({u,v,el: <path class="peer">}))`.
- `layout()` (≈L186–192): positions nodes on a circle and sets each peer wire's
  `d` via `curve()`.
- `loadActivity()` (≈L202–226): fetches `/api/activity`; toggles `.work` on
  working nodes; **for every `e` in `act.edges` with `e.active`, calls
  `travel(e.from, e.to)`** — which animates a single dot along `curve()` then
  removes it. There is **no persistent observed edge**; non-`active` edges and
  observed-but-unwired pairs leave no visible line.
- `travel(a,b)` (≈L194–200): guarded by `if (!byName[a] || !byName[b]) return;`.

`src/dashboard/public/graph-view.css`:

- `.peer { stroke:#d4ccba; stroke-width:1.4; fill:none }` — solid taupe wire.
- `.arc { stroke:var(--amber); stroke-dasharray:7 5; animation:dashmove … }`,
  `.gpulse { fill:var(--amber) }` — the traveling pulse.

## Design

### Data model (client-side, in `graph-view.js`)

Add one module-scoped map, parallel to `peerEls`:

```js
let oedges = {};   // key `from|to` → { from, to, el }  (observed edges, persistent)
```

`peerEls` (capability) is built **once** in `ensureGraph()` and never changes.
`oedges` (observed) is **reconciled every `loadActivity()`** against `act.edges`.

### Layer 1 — Capability wires (faint/dashed)

Restyle, no JS structural change. The `gPeer` group is drawn under everything
(it already is — appended first). Wires get a faint, dashed, low-opacity
treatment so they read as "standing capability," not traffic:

```css
#view-graph .peer{stroke:#cabfa3;stroke-width:1.3;stroke-dasharray:5 5;fill:none;opacity:.5}
```

`layout()` already redraws `peer` `d` on resize — unchanged.

### Layer 2 — Observed edges (persistent, teal when active)

A new SVG group `gObs` is created in `ensureGraph()` **between** `gPeer` and
`gArc` so observed lines sit above capability wires but below the traveling
pulse and the nodes:

```js
const gPeer = mk('g'), gObs = mk('g'), ga = mk('g'), gNode = mk('g');
field.append(gPeer, gObs, ga, gNode); gArc = ga;
```

The **pure** `reconcileObserved` (see Testing) decides what changes; `loadActivity`
is the thin impure shell that applies the decision to the SVG. The decision is
made against the edges **whose endpoints are both known nodes** — the caller
filters with the same guard `travel()` uses, so `reconcileObserved` stays a pure
set-diff with no knowledge of `byName`:

```js
// in loadActivity(), after fetching `act`:
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

// traveling pulse stays on every active edge (add OR already-present)
for (const e of known) if (e.active) travel(e.from, e.to);
```

`add` entries always (re)set `d`; `update` only flips the `active` class (the
path geometry is fixed until a resize, which `layout()` handles). This keeps the
membership/active decision entirely inside the unit-tested `reconcileObserved`,
with `loadActivity` doing only DOM mutation.

`layout()` must also re-path observed edges on resize (they share `curve()`):

```js
for (const key of Object.keys(oedges)) {
  const o = oedges[key];
  if (byName[o.from] && byName[o.to]) o.el.setAttribute('d', curve(byName[o.from], byName[o.to]));
}
```

CSS for the observed layer (teal active, faint recently-seen, smooth fade):

```css
#view-graph .oedge{stroke:#bdb091;stroke-width:1.6;fill:none;opacity:.34;
  transition:stroke .35s,stroke-width .35s,opacity .5s}
#view-graph .oedge.active{stroke:var(--teal2);stroke-width:2.6;opacity:.95}
```

Recolor the traveling pulse from amber to teal so the moving dot reads as the
same "communication" signal as the observed edge it rides:

```css
#view-graph .arc{...;stroke:var(--teal2);...}   /* was var(--amber) */
#view-graph .gpulse{fill:var(--teal2)}          /* was var(--amber) */
```

### Legend

Add a small inline legend to the graph section header (`#sec-graph .shead`),
after the `● live` indicator, so the two layers are self-explanatory:

```html
<span class="gv-legend">
  <i class="lg-cap"></i>can delegate
  <i class="lg-obs"></i>communicating
</span>
```

```css
#view-graph .gv-legend{display:inline-flex;gap:12px;align-items:center;font:10px var(--mono);color:var(--ink2);margin-left:8px}
#view-graph .gv-legend i{display:inline-block;width:18px;height:0;vertical-align:middle;margin-right:4px}
#view-graph .gv-legend .lg-cap{border-top:1.4px dashed #cabfa3}
#view-graph .gv-legend .lg-obs{border-top:2.4px solid var(--teal2)}
```

(The header is a flex row with `[data-fold]`; the legend is inert text and must
not intercept the fold click — it has no handler, so a click bubbles to the
fold handler as before. Verify the fold/maximize still work.)

## Data Flow

```
/api/mesh   ──once──▶ ensureGraph ──▶ peerEls (capability, static)  ─▶ gPeer (faint dashed)
/api/activity ─poll─▶ loadActivity ─▶ reconcile oedges (observed)   ─▶ gObs  (teal when active)
                                   └▶ travel() on active            ─▶ gArc  (teal pulse)
                      (SSE 'activity' event re-triggers loadActivity)
```

No new fetches; `loadActivity` already runs on initial load and on every
`/api/events` SSE `activity` event.

## Error Handling

- Unchanged fetch guards: `loadActivity` already `try/catch`es `/api/activity`
  and returns on failure (observed edges simply don't update — last state
  persists, consistent with current behavior).
- `obsEdge` returns `null` for unknown endpoints (mirrors `travel`'s guard), so
  a malformed/cross-plane edge can never create a dangling path or throw.
- Empty mesh (`names = ['mesh']` fallback) → no peers, no observed edges; graph
  shows a single node, same as today.

## Testing

The dashboard frontend (`src/dashboard/public/*.js`) is browser ES-module code
with no existing unit harness (it's verified via the running dashboard). To stay
consistent with the repo's hermetic `node --test` discipline **without**
introducing a DOM/browser dependency, factor the pure reconciliation decision
into a tiny testable helper and unit-test that; drive the SVG mutation from it.

Add `reconcileObserved(prevKeys, edges)` — a pure function returning
`{ add:[{from,to,active}], update:[{key,active}], remove:[key] }` given the
previous key set and the new `act.edges`. `loadActivity` calls it and applies
the result to `oedges`/`gObs`.

`test/graph-observed.test.js` (new, `node --test`, zero deps):

- **Adds a new observed edge** not seen before → appears in `add`.
- **Marks an edge active/inactive** across reconciles → appears in `update`
  with the right `active`.
- **Removes an edge** that dropped out of the window → appears in `remove`.
- **Skips self-loops are already dropped upstream** — assert `reconcile` is
  agnostic (passes through whatever edges it's given; the `from===to` drop lives
  in `buildActivity`, already covered by `test/activity.test.js`).
- **Stable identity**: an edge present and unchanged across two reconciles
  yields neither `add` nor `remove` (only possibly `update` if `active`
  flipped).

`reconcileObserved` lives in a new pure module
`src/dashboard/public/graph-observed.js` (importable by both the browser module
and the test). `graph-view.js` imports it. This matches the repo's
pure-core/impure-shell split: the reconcile logic is unit-proven; the SVG
append/remove is the thin impure shell.

## Files

- **Modify** `src/dashboard/public/graph-view.js` — add the `gObs` group and the
  `oedges` map, import + apply `reconcileObserved` in `loadActivity`, re-path
  observed edges in `layout()`, add the legend span to `TEMPLATE`.
- **Create** `src/dashboard/public/graph-observed.js` — pure
  `reconcileObserved(prevKeys, edges)`.
- **Modify** `src/dashboard/public/graph-view.css` — restyle `.peer`
  (faint/dashed), add `.oedge` / `.oedge.active`, recolor `.arc` / `.gpulse`
  to teal, add `.gv-legend`.
- **Create** `test/graph-observed.test.js` — unit tests for `reconcileObserved`.

## Verification (manual, running dashboard)

1. Start the dashboard, open the Graph view, confirm peer wires render
   **faint/dashed** and the legend shows both swatches.
2. With live mesh activity (or a seeded run-log), confirm an active delegation
   draws a **teal** edge + traveling pulse, including a pair that has **no**
   dashed wire between them (cross-plane traffic now visible).
3. Confirm an edge **fades/disappears** after it ages out of the activity
   window (next `loadActivity` after the record leaves the window).
4. Confirm fold/maximize on `#sec-graph` still work with the legend present.
5. Resize the panel; confirm both layers re-path correctly.

## Invariants preserved

- **No task text / result data on the board.** `/api/activity` `edges` carry
  only `{from,to,active,kind}` (status, not content) — unchanged. The observed
  layer renders structure only.
- **Capability ≠ permission spoof.** Wires still come solely from the
  marker-validated `/api/mesh` (registry) data; the observed layer never grants
  or implies a capability — it only reports traffic.
