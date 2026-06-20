# Path-Guard Path-Separator Normalization

**Date:** 2026-06-18
**Issue:** #83
**Status:** implemented

## Problem

`realpath` on Windows returns backslash-separated paths. Claude generates `file_path`
values using `/` (POSIX-heavy training corpus). For **non-existent paths**,
`canonicalizePossiblyMissing` walks up via `dirname` + `resolve`; on Node 22 Windows,
a mixed-separator input can produce inconsistent separators in `canonicalRoot` and
`canonicalCandidate` before they reach `relative()`.

Two concrete failure modes:

**Bug A — `isPathInsideRoot`:** `rel.includes(`..${sep}`)` where `sep === '\\'` on
Windows misses a `../`-prefixed traversal (forward-slash result from `relative`) →
write-confinement hole. A path outside the root passes the guard.

**Bug B — `isProtectedConfigPath`:** `rel.split(sep)` on Windows yields a
single-element array when `rel` uses `/` → the top-level segment check never fires →
Boundary-5 (protected config) bypass.

## Design

**Normalize after full canonicalization — never before.** Symlink resolution
(`realpath` / `canonicalizePossiblyMissing`) must see native paths. After both root
and candidate are fully resolved, apply:

```js
function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}
```

Then use `pathPosix.relative(normRoot, normCandidate)` and the literal `'/'` character
in all comparisons — removing the dependency on `sep`.

This is a no-op on POSIX (`realpath` on POSIX never produces `\`).

## Scope

- `src/path-guard.js` — `toForwardSlash` helper; `pathPosix` import; apply
  normalization in both `isPathInsideRoot` and `isProtectedConfigPath` after
  `canonicalizePossiblyMissing`; use `pathPosix.relative` + `'/'` everywhere.
- `test/path-guard.test.js` — three new assertions: (1) backslash-relative inside
  root, (2) backslash traversal blocked after normalization, (3) backslash protected-config path.
- No other files changed.

## Invariants

| Invariant | How |
|---|---|
| Write confinement | `pathPosix.relative` still produces `..`-prefixed rel for paths outside normRoot |
| Symlink resolution before authorization | `canonicalizePossiblyMissing` runs *before* normalization |
| Protected config (Boundary 5) | `rel.split('/')` after normalization gives the correct top-level segment |
| Anti-spoof | Not affected — call-path/depth is env-threaded, not path-guard |

## Risks

- `\` is valid in POSIX filenames. Mitigated: normalization applies only to
  `realpath`/`resolve` output, which never contains `\` on POSIX.
- Cross-drive Windows paths (`C:` vs `D:`): `pathPosix.relative` produces
  `../../D:/other`, correctly triggering the `startsWith('..')` denial.
