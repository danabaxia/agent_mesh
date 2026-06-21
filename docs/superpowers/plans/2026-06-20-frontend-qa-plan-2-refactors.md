# Front-End QA — Plan 2: safe zero-dep refactors (DOM extractions deferred to Plan 3)

Status: delivered
Scope: the SAFE, behavior-preserving, zero-dependency slice of the Front-End QA
test-suite design. The large DOM-view carve-ups in the full design require jsdom
(golden-master DOM parity), which only arrives in Plan 3 — those are explicitly
deferred here (see "Deferred to Plan 3").

## Context

Plan 1 (merged, PR #303) added the zero-dep L0 layer:
- pure modules `src/dashboard/public/freshness.js`, `graph-view-model.js`,
  and the route manifest `src/dashboard/routes-manifest.js`;
- a client-URL → manifest **advisory** dead-route check
  (`test/deadcode-routes.test.js`);
- an orphan-module check (`test/deadcode-orphans.test.js`) with an ALLOWLIST
  holding `freshness.js` + `graph-view-model.js` as "future-wired, no consumer".

Plan 2 continues with only the slices that are provably behavior-preserving
**without a DOM**: pure-function extraction + unit tests, and an *enforcing*
upgrade of the route check. No new dependencies — only `node:test`,
`node:assert/strict`, `node:fs`, `node:path`, `node:url`. The full suite
(`node run-all-tests.mjs`) stays green.

## What this plan delivered

### Piece 1 — `net-graph-layout.js` (pure geometry)
New module `src/dashboard/public/net-graph-layout.js` extracts the deterministic
geometry/sizing math from `net-graph.js` (the non-deterministic force-physics
x/y sim stays in `net-graph.js`):
- `nodeRadius(volume, maxVol)` — `13 + 15*sqrt(volume/maxVol)`, `maxVol` guarded ≥1;
- `buildNodes(agents)` — `{id,label,color,r}` per agent, volume-scaled;
- `buildEdges(links)` — undirected edge dedup (first-seen wins), mirroring
  `rebuildLinks`'s `[a,b].sort().join('|')` key.
Test: `test/dashboard-net-graph-layout.test.js` (3 tests) pins exact node count,
hand-computed radii, and edge dedup.
**Wiring:** `net-graph.js` now imports `nodeRadius` and uses it where it inlined
the same formula — a trivially-safe substitution (byte-identical for finite
volumes, the real data contract). `buildNodes`/`buildEdges` landed additive
(the view still owns node identity/lifecycle); they are exercised via the import
graph so the module is not orphaned.

### Piece 2 — `session-view-model.js` (pure session helpers)
New module `src/dashboard/public/session-view-model.js` extracts the
deterministic, DOM-free helpers **verbatim** from `session-view.js`:
- `circ(n)` — ①…⑳ then `#N` ordinal glyphs;
- `preview(s, n)` — char truncation with a trailing " …";
- `capUtf8(s, max)` — UTF-8 byte-boundary capping (binary search);
- `rawFromRecords(records)` — rebuild raw-shaped JSONL records from the server's
  redacted envelope events (sidechain-skipping, seq order).
Test: `test/dashboard-session-view-model.test.js` (4 tests).
**Wiring:** `session-view.js` imports all four and its inline definitions were
deleted — a trivially-safe substitution (the function bodies are identical).
`rawFromRecords` is re-exported from `session-view.js` to preserve its prior
public surface. The Date/locale formatters (`fmtFull`/`fmtClock`/`dur`) stay in
the view because they are non-deterministic (locale + `new Date()`), so they are
out of scope for a deterministic pure module.

### Piece 3 — route-manifest ↔ server EQUIVALENCE (enforcing)
New `test/deadcode-routes-equivalence.test.js` upgrades Plan 1's advisory
client→manifest check to a **bidirectional, enforcing** manifest↔server check.
It statically parses (zero-dep, no server started) the real `/api/*` routes out
of `server.js`'s handler dispatch — the `pathname === '/api/...'` fixed routes,
the `pathname.endsWith('/<suffix>')` agent-suffix routes, the regex-matched
`:id` routes, the consolidated `/session/*` matcher, and the `/api/agent/:name`
catch-all — and asserts:
- **(a)** every server route is matched by some manifest pattern (no
  unregistered route), and
- **(b)** every manifest pattern matches at least one real server route (no dead
  pattern).
**Finding:** the Plan-1 manifest was already fully in sync with `server.js`
(20 fixed routes + every dynamic `/api/agent/:name` family) — **no
reconciliation was required**. There were no unregistered server routes and no
dead manifest patterns. The check now hard-gates that truth: future server route
changes that drift from the manifest (or stale manifest patterns) will fail CI.
`server.js` is the source of truth — if this ever fails, reconcile the manifest
to the server, never the reverse.

### Piece 4 — wire Plan-1 future-wired modules (evaluated; LEFT ADDITIVE)
Goal: shrink the orphan allowlist by wiring `freshness.js` / `graph-view-model.js`
into a real consumer **iff** the substitution is trivially-safe and
behavior-preserving. After reading the candidate consumers:
- `graph-view-model.js` does **not** match the inline graph-view code:
  - `issuesLabel(issues)` returns `"N open total"`, but graph-view.js renders
    `` `${iss.openNow ?? 0} open total · ${labels}` `` (extra `· ${labels}`
    suffix) — wiring would change rendered text.
  - `tokenTotal({series})` sums a `series` array, but graph-view.js computes
    `r.tokens.total.input + r.tokens.total.output` (a different data shape) —
    wiring would compute against the wrong shape.
- `freshness.js` (`isStale`/`backoffDelays`) has **no** matching inline code in
  `graph-view.js`/`board2.js`. The existing `setInterval`/`relTime`/`Date.now()`
  usages compute relative-time strings or fixed-interval polls — none share the
  threshold-comparison or exponential-backoff semantics of these helpers.
**Decision:** neither wiring is trivially-safe and behavior-preserving without a
DOM to verify the rendered result, so **both allowlist entries are KEPT**. Per
the plan's hard rule, the modules stay additive (created + unit-tested) rather
than risk breaking a view to force a wiring. Wiring them is genuinely a Plan 3
job (it introduces NEW UI behavior — a staleness affordance / a backoff poll —
that needs DOM verification). No code changed for this piece.

## Deferred to Plan 3 (and why)

1. **`session-view.js` (734L) and `graph-view.js` (514L) model/view extraction
   with golden-master DOM parity.** The full QA design carves the DOM-rendering
   bodies of these views into testable model + thin view layers, gated by a
   golden-master DOM parity harness (render-before vs render-after must be
   byte-identical). That harness needs **jsdom** to instantiate a DOM in the
   test runner. jsdom is a dependency, and Plan 2 is strictly zero-dep, so the
   DOM carve-ups wait for Plan 3 (which introduces the jsdom-backed test layer).
   Plan 2 deliberately extracted only the *already-pure, deterministic* helpers
   from these files — never their DOM rendering.

2. **Freshness UI affordance wiring.** Wiring `freshness.js`
   (`isStale`/`backoffDelays`) into the dashboard's poll loop / a "data is
   stale" affordance changes rendered/observable behavior and must be verified
   against a DOM. Deferred to Plan 3 with the jsdom harness; the allowlist entry
   stays until then.

3. **`graph-view-model.js` wiring.** Same reasoning — the helpers don't match the
   current inline code, so adopting them means changing the view's output, which
   needs DOM verification. Deferred; allowlist entry stays.

4. **Router-as-source-of-truth registration.** The enforcing equivalence check
   (Piece 3) keeps the manifest and server in lockstep via a static test, but it
   does not *restructure* `server.js`'s dispatch into a declarative router table
   that the manifest is generated from. That refactor is invasive (it rewrites
   the request dispatch) and is out of scope for the safe slice; deferred.

## Verification

- New tests: `test/dashboard-net-graph-layout.test.js` (3),
  `test/dashboard-session-view-model.test.js` (4),
  `test/deadcode-routes-equivalence.test.js` (2) — 9 new tests.
- `test/deadcode-orphans.test.js` stays green: `net-graph-layout.js` and
  `session-view-model.js` are reachable via the import graph (wired into
  `net-graph.js` / `session-view.js`); `freshness.js` + `graph-view-model.js`
  remain allowlisted.
- The full suite (`node run-all-tests.mjs`) stays green — every wiring was a
  byte-identical pure-function substitution, so no view behavior changed.
