# Final-Review Fixes Report

**Branch:** worktree-label-aware-issue-sweep  
**Files changed:** `scripts/dev-society-daemon.mjs`, `test/issue-sweep-schedule.test.js`

---

## FIX 1 (Critical) — issue-sweep builtin returns a status object

**File:** `scripts/dev-society-daemon.mjs`

Changed the `issue-sweep` builtin registration from a bare `.catch()` (resolving to `undefined` → always recorded as FAIL by `scheduler.js`) to a proper `.then()`/`.catch()` chain returning `{ status: 'ok' }` on success and `{ status: 'fail', error }` on failure, matching the pattern of `daily-report-refresh` and `gh-activity-poll`.

---

## FIX 2 (Important) — document why liveBuilds is empty

**File:** `scripts/dev-society-daemon.mjs`

Added a 4-line comment directly above `const liveBuilds = new Set();` in `sweep()` explaining the invariant: the scheduler runs one issue-sweep at a time, `runOneTask` is awaited within the tick so no concurrent builds exist, and stale-reclaim relies on `STALE_MS` exceeding `cfg.timeoutMs`.

---

## FIX 3 (Minor) — slug trailing hyphen

**File:** `scripts/dev-society-daemon.mjs`

In `runSpecTask`, appended `.replace(/-+$/, '')` after `.slice(0, 60)` so a hyphen at position 59 (surviving the length cap) is stripped from the filename slug.

---

## FIX 4 (Minor) — listAllOpen comment

**File:** `scripts/dev-society-daemon.mjs`

Added `// All open issues, intentionally UNFILTERED by label — routeFor does all gating/skip logic.` directly above `async function listAllOpen()`.

---

## FIX 5 — lint test for the status object

**File:** `test/issue-sweep-schedule.test.js`

Added assertion to the first test:
```js
assert.match(d, /issue-sweep'[\s\S]{0,200}status: 'ok'/, 'issue-sweep builtin returns a status object');
```

---

## Verify outputs

```
node --check scripts/dev-society-daemon.mjs
→ syntax OK

node scripts/dev-society-daemon.mjs --selftest
→ selftest routing: {"10":null,"11":"analyst","12":"coder","13":"triager","14":"analyst","15":null,"16":"analyst"}
→ selftest OK

node --test test/issue-sweep-schedule.test.js
→ ✔ daemon registers the issue-sweep builtin and routes via routeFor (1.675958ms)
→ ✔ maintainer schedules issue-sweep every 10 minutes (0.584791ms)
→ tests 2 | pass 2 | fail 0

node --test test/dev-society.test.js
→ tests 22 | pass 22 | fail 0
```
