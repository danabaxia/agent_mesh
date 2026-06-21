import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_PATTERNS } from '../src/dashboard/routes-manifest.js';

// ───────────────────────────────────────────────────────────────────────────
// BIDIRECTIONAL, enforcing route truth: parse the REAL /api/* routes out of
// server.js's handler dispatch (zero-dep, static text analysis — no server is
// started) and assert EQUIVALENCE with the client-facing ROUTE_PATTERNS:
//
//   (a) every server route is matched by some manifest pattern  (no unregistered route)
//   (b) every manifest pattern matches at least one server route (no dead pattern)
//
// server.js is the source of truth: if (a) or (b) fails, reconcile the manifest
// to the server, never the reverse.
// ───────────────────────────────────────────────────────────────────────────

const SERVER = readFileSync(join('src', 'dashboard', 'server.js'), 'utf8');

// A representative concrete URL per server route. Building a concrete URL (not a
// pattern) lets us test BOTH directions with one set: direction (a) feeds these
// through the manifest; direction (b) checks each manifest pattern matches one.
const AGENT = 'lib';
const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Extract the fixed `pathname === '/api/...'` equality routes.
function fixedRoutes(src) {
  const out = new Set();
  for (const m of src.matchAll(/pathname\s*===\s*'(\/api\/[^']*)'/g)) out.add(m[1]);
  return [...out];
}

// Extract the dynamic `/api/agent/:name/...` routes, expressed as concrete URLs.
// These come from three server idioms:
//   pathname.startsWith('/api/agent/') && pathname.endsWith('/<suffix>')
//   pathname.endsWith('/shell/plan') || .endsWith('/shell/launch')
//   pathname.match(/^\/api\/agent\/(.+?)\/<...>$/)
// plus the catch-all `/api/agent/:name` and the consolidated /session/ matcher.
function agentRoutes(src) {
  const out = new Set();
  // endsWith('/<suffix>') — suffix may contain a slash (e.g. /deliverable/locate)
  for (const m of src.matchAll(/pathname\.endsWith\('(\/[^']+)'\)/g)) {
    const suffix = m[1];
    out.add(`/api/agent/${AGENT}${suffix}`);
  }
  return out;
}

// The hand-verified set of dynamic agent routes the server actually serves,
// each as a concrete URL. Derived from server.js dispatch (see grep above);
// the suffix-scan in agentRoutes() seeds it, then we add the regex-matched and
// catch-all routes that aren't simple endsWith() checks.
function serverRoutes() {
  const fixed = fixedRoutes(SERVER);
  const agentSuffix = [...agentRoutes(SERVER)].filter((u) => {
    // keep only agent routes whose suffix is a real /api/agent route (drop the
    // bare '/' and any non-api endsWith that isn't part of the agent family).
    return u.startsWith(`/api/agent/${AGENT}/`);
  });
  const regexRoutes = [
    `/api/agent/${AGENT}/artifact/some-slug`,                 // DELETE /artifact/:slug
    `/api/agent/${AGENT}/workflow/some-slug`,                 // DELETE /workflow/:slug
    `/api/agent/${AGENT}/schedule/some-id/run`,               // POST /schedule/:id/run
    `/api/agent/${AGENT}/schedule/some-id/enable`,            // POST /schedule/:id/enable
    `/api/agent/${AGENT}/schedule/some-id`,                   // DELETE /schedule/:id
    `/api/agent/${AGENT}/session/message`,                    // /session/(message|stop|list|resume-command)
    `/api/agent/${AGENT}/session/stop`,
    `/api/agent/${AGENT}/session/list`,
    `/api/agent/${AGENT}/session/resume-command`,
    `/api/agent/${AGENT}/session/${UUID}/transcript`,         // /session/:uuid/(transcript|stream|...)
    `/api/agent/${AGENT}/session/${UUID}/stream`,
    `/api/agent/${AGENT}/session/${UUID}/resume`,
    `/api/agent/${AGENT}/session/${UUID}/open-terminal`,
    `/api/agent/${AGENT}/session/${UUID}/rename`,
    `/api/agent/${AGENT}/session/${UUID}/delete`,
  ];
  const catchAll = [`/api/agent/${AGENT}`];                   // /api/agent/:name (info)
  return [...new Set([...fixed, ...agentSuffix, ...regexRoutes, ...catchAll])].sort();
}

test('(a) every server /api route is matched by a manifest pattern (no unregistered route)', () => {
  const routes = serverRoutes();
  // sanity: the scan found a substantial route set, not an empty one
  assert.ok(routes.length >= 35, `expected many server routes, found ${routes.length}`);
  const unregistered = routes.filter((u) => !ROUTE_PATTERNS.some((re) => re.test(u)));
  assert.deepEqual(unregistered, [], `server routes with no manifest pattern: ${unregistered.join(', ')}`);
});

test('(b) every manifest pattern matches at least one real server route (no dead pattern)', () => {
  const routes = serverRoutes();
  const dead = ROUTE_PATTERNS.filter((re) => !routes.some((u) => re.test(u)));
  assert.deepEqual(dead.map(String), [], `manifest patterns matching no server route: ${dead.map(String).join(', ')}`);
});
