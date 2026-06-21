// test/ui/merge-sweep-render.component.test.js — COMPONENT tier (jsdom + axe).
// Mounts the REAL merge-sweep report builder (src/dashboard/public/
// merge-sweep-render.js → renderMergeSweep) into jsdom and asserts the report
// structure (checkpoints, items, PR/issue links) via DOM queries + data-testid,
// then runs axe for the jsdom-meaningful categories (links have discernible
// names, ARIA/structure valid; NOT contrast/focus — see _jsdom-axe.js).
//
// Deterministic: the report is a plain data fixture; no time/RNG is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeSweep } from '../../src/dashboard/public/merge-sweep-render.js';
import { mount, inMain, runAxe, assertNoAxeViolations } from './_jsdom-axe.js';

const REPORT = {
  available: true,
  stale: false,
  summary: { flagged: 1, ok: 2 },
  checkpoints: [
    {
      name: 'open PRs',
      status: 'flagged',
      items: [
        {
          number: 42,
          ref: 'PR #42',
          state: 'stale',
          detail: 'no review in 3 days',
          ageRuns: 3,
          remediation: { state: 'filed', issueNumber: 99 },
        },
      ],
    },
    { name: 'recent merges', status: 'ok', items: [{ ref: 'main@abc123', state: 'clean', detail: 'merged cleanly' }] },
  ],
};

function mountReport(rep) {
  // renderMergeSweep returns a fragment string; mount it inside a labelled region
  // (mirroring its placement in the graph view) so structural rules have context.
  return mount(inMain(`<section data-testid="merge-sweep">${renderMergeSweep(rep)}</section>`, 'Merge sweep'));
}

test('component: merge-sweep report renders header counts + checkpoints + linked PR', async () => {
  const { document, byTestId, text } = mountReport(REPORT);

  assert.ok(byTestId('merge-sweep'), 'report region mounted');
  assert.match(text(), /flagged 1/, 'flagged count');
  assert.match(text(), /clean 2/, 'clean count');

  // The PR link must be a real anchor with an accessible name and a safe target.
  const link = [...document.querySelectorAll('a')].find((a) => /pull\/42$/.test(a.getAttribute('href')));
  assert.ok(link, 'PR #42 link rendered');
  assert.equal(link.getAttribute('rel'), 'noopener', 'external link is rel=noopener');
  assert.match(link.textContent, /PR #42/, 'link has a discernible accessible name');

  // The remediation issue link is present and numeric-coerced.
  const issue = [...document.querySelectorAll('a')].find((a) => /issues\/99$/.test(a.getAttribute('href')));
  assert.ok(issue, 'remediation issue #99 link rendered');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});

test('component: empty report renders the empty-state, no dangling links', async () => {
  const { document, text } = mountReport({ available: false });
  assert.match(text(), /no merge-sweep report yet/);
  assert.equal(document.querySelectorAll('a').length, 0, 'no links in the empty state');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});

test('component: a hostile item detail/ref is escaped (no injected nodes)', async () => {
  const rep = {
    available: true,
    summary: { flagged: 1, ok: 0 },
    checkpoints: [{ name: '<b>x</b>', status: 'flagged', items: [{ ref: '<script>bad()</script>', state: 'stale', detail: '<img src=x onerror=1>' }] }],
  };
  const { document } = mountReport(rep);
  assert.equal(document.querySelectorAll('script').length, 0, 'no <script> node materialized');
  assert.equal(document.querySelectorAll('img').length, 0, 'no <img> node materialized');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});
