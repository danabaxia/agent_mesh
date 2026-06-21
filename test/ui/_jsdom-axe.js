// test/ui/_jsdom-axe.js — shared jsdom + axe harness for the component tier.
//
// NIGHTLY-ONLY. Requires the Plan-3 devDependencies (jsdom, axe-core). These
// tests live UNDER test/ui/ (a subdir), so the zero-install L0 runner
// (run-all-tests.mjs, which only globs top-level test/*.test.js) never discovers
// them and ci.yml stays dependency-free. They run in the nightly
// integration.yml `frontend-qa-component` job (gating) via `node --test test/ui/`.
//
// What axe CAN check under jsdom: name/role/value, ARIA validity, required-children/
// parent relationships, heading/landmark/list STRUCTURE, duplicate ids, label
// associations, img alt — everything derivable from the accessibility tree of the
// static DOM.
// What axe CANNOT honestly check under jsdom (do NOT assert on these here; they
// need a real browser with layout + a paint, covered by the Playwright e2e tier):
//   - color-contrast (no computed colors / layout)
//   - focus visibility / focus order under real tab navigation
//   - anything depending on getBoundingClientRect / actual rendering
// jsdom is a DOM, not a renderer — so runAxe() disables the paint-dependent rules
// explicitly, making a green run an honest signal rather than a false pass on
// rules axe would silently skip under jsdom anyway.

import { JSDOM } from 'jsdom';
import axe from 'axe-core';

let _installed = false;
// axe-core reads window/document/Node from globals at run time. Install the jsdom
// realm's globals once (idempotent) before the first axe.run.
function installGlobals(window) {
  if (_installed) return;
  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.NodeList = window.NodeList;
  global.HTMLElement = window.HTMLElement;
  global.Element = window.Element;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  _installed = true;
}

// Wrap a bare fragment in a labelled <main> landmark so the fragment under test
// satisfies the region/landmark structural rules in isolation (the fragment ships
// inside the full board2.html, which DOES have landmarks; we reproduce that
// context so the component test exercises the markup, not the missing page chrome).
export function inMain(fragmentHtml, label = 'component under test') {
  return `<main aria-label="${label}">${fragmentHtml}</main>`;
}

// Mount an HTML string into a fresh jsdom document. Deterministic: no network, no
// page scripts run (the fragments are pure markup from our string-builders).
export function mount(bodyHtml) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html lang="en"><head><title>component-under-test</title></head><body>${bodyHtml}</body></html>`,
  );
  installGlobals(dom.window);
  const { document } = dom.window;
  return {
    dom,
    document,
    window: dom.window,
    byTestId: (id) => document.querySelector(`[data-testid="${id}"]`),
    byRole: (role) => [...document.querySelectorAll(`[role="${role}"]`)],
    text: () => document.body.textContent,
  };
}

// Paint-dependent rules axe cannot evaluate honestly without a real browser.
const PAINT_DEPENDENT_RULES = {
  'color-contrast': { enabled: false },
  'color-contrast-enhanced': { enabled: false },
};

// Run axe over a jsdom document, restricted to rule categories meaningful without
// a paint. Returns the axe results object.
export async function runAxe(document) {
  installGlobals(document.defaultView);
  return axe.run(document.documentElement, {
    elementRef: false,
    resultTypes: ['violations'],
    rules: PAINT_DEPENDENT_RULES,
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
  });
}

// Assert axe found no violations, with a readable failure message listing each
// violating rule + node HTML so a regression is diagnosable from the CI log.
export function assertNoAxeViolations(results, assert) {
  const v = (results && results.violations) || [];
  const summary = v
    .map((x) => `  [${x.impact || 'n/a'}] ${x.id}: ${x.help}\n    nodes: ${x.nodes.map((n) => n.html).join(' | ')}`)
    .join('\n');
  assert.equal(v.length, 0, v.length ? `axe violations (${v.length}):\n${summary}` : 'no axe violations');
}
