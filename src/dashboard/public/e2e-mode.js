// src/dashboard/public/e2e-mode.js — deterministic-render hook for the Playwright
// e2e/visual tier (Plan 3). BEHAVIOR-NEUTRAL for normal use: every export is a
// no-op unless e2e mode is explicitly requested via `?e2e=1` (query) or the
// `__E2E__` global. Normal dashboard sessions never opt in, so production
// rendering, RNG, and animation are untouched.
//
// Why this exists: the live board has two sources of non-determinism that defeat
// pixel-stable visual regression — the net-graph force simulation seeds node
// positions with Math.random() and animates via requestAnimationFrame. Under e2e
// mode we (1) replace Math.random with a fixed-seed PRNG so initial placement is
// reproducible, and (2) let net-graph collapse the physics to a settled layout in
// one synchronous pass (see netGraphSettleAlpha). The page then stamps
// <body data-render-state="settled"> once the initial data render completes, which
// is the single signal the Playwright spec awaits — no arbitrary sleeps.

export function e2eEnabled() {
  try {
    if (typeof window !== 'undefined' && window.__E2E__ === true) return true;
    const q = new URLSearchParams(globalThis.location?.search || '');
    return q.get('e2e') === '1';
  } catch {
    return false;
  }
}

// Mulberry32 — tiny deterministic PRNG. Same seed → same sequence, so node
// placement and any other Math.random consumer is reproducible under e2e.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _seeded = false;
// Install the seeded PRNG over Math.random (idempotent). Only call under e2e.
export function seedRng(seed = 0x9e3779b9) {
  if (_seeded || !e2eEnabled()) return;
  const rng = mulberry32(seed);
  Math.random = rng;
  _seeded = true;
}

// Under e2e, the net-graph should converge to a settled layout immediately rather
// than animate. Returns the number of synchronous physics iterations net-graph
// should run up-front (0 = leave the live animated path). Behavior-neutral off e2e.
export function netGraphSettleIterations() {
  return e2eEnabled() ? 600 : 0;
}

// Stamp the render-settled signal exactly once. The Playwright spec waits for
// body[data-render-state="settled"]. Off e2e this is harmless (it just sets an
// attribute no one reads). Call after the initial data render completes.
export function markRenderSettled(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || !doc.body) return;
  doc.body.setAttribute('data-render-state', 'settled');
}
