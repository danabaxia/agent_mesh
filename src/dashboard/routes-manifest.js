/**
 * src/dashboard/routes-manifest.js
 *
 * PURE manifest of every /api/* route registered in server.js.
 * One anchored RegExp per route (or route family).
 * Used by the zero-dep route-reachability test (test/deadcode-routes.test.js).
 *
 * Keep in sync with src/dashboard/server.js handleRequest().
 */

const AGENT = '[^/]+';

export const ROUTE_PATTERNS = [
  // ── Fixed routes ────────────────────────────────────────────────────────
  /^\/api\/activity$/,          // GET  /api/activity
  /^\/api\/activity-log$/,      // GET  /api/activity-log
  /^\/api\/ci-schedules$/,      // GET  /api/ci-schedules
  /^\/api\/collab$/,            // GET  /api/collab
  /^\/api\/concierge\/message$/, // POST /api/concierge/message  (mobile concierge)
  /^\/api\/concierge\/confirm$/, // POST /api/concierge/confirm  (mobile concierge)
  /^\/api\/concierge\/history$/, // GET  /api/concierge/history  (mobile concierge, issue #362)
  /^\/api\/daily$/,             // GET  /api/daily
  /^\/api\/daily\/refresh$/,    // POST /api/daily/refresh
  /^\/api\/events$/,            // GET  /api/events  (SSE)
  /^\/api\/file$/,              // GET  /api/file
  /^\/api\/health$/,            // GET  /api/health
  /^\/api\/img$/,               // GET  /api/img
  /^\/api\/mcps$/,              // GET  /api/mcps
  /^\/api\/merge-sweep$/,       // GET  /api/merge-sweep
  /^\/api\/mesh$/,              // GET  /api/mesh
  /^\/api\/resources$/,         // GET  /api/resources
  /^\/api\/schedules$/,         // GET  /api/schedules
  /^\/api\/schedules\/run$/,    // POST /api/schedules/run
  /^\/api\/skills$/,            // GET  /api/skills
  /^\/api\/tokens$/,            // GET  /api/tokens  (also ?range=...)
  /^\/api\/tree$/,              // GET  /api/tree
  /^\/api\/usage$/,             // GET  /api/usage

  // ── /api/agent/:name — dynamic-suffix routes ────────────────────────────
  new RegExp(`^/api/agent/${AGENT}/activity-stats$`),
  new RegExp(`^/api/agent/${AGENT}/artifact/${AGENT}$`),
  new RegExp(`^/api/agent/${AGENT}/artifacts$`),
  new RegExp(`^/api/agent/${AGENT}/deliverable$`),
  new RegExp(`^/api/agent/${AGENT}/deliverable/locate$`),
  new RegExp(`^/api/agent/${AGENT}/deliverables$`),
  new RegExp(`^/api/agent/${AGENT}/message$`),
  new RegExp(`^/api/agent/${AGENT}/schedule$`),
  new RegExp(`^/api/agent/${AGENT}/schedule/${AGENT}$`),
  new RegExp(`^/api/agent/${AGENT}/schedule/${AGENT}/(run|enable)$`),
  new RegExp(`^/api/agent/${AGENT}/shell/(plan|launch)$`),
  new RegExp(`^/api/agent/${AGENT}/workflow/${AGENT}$`),
  new RegExp(`^/api/agent/${AGENT}/workflows$`),
  new RegExp(`^/api/agent/${AGENT}/worklog$`),
  // Catch-all agent info (must be last; matched after all specific suffixes)
  new RegExp(`^/api/agent/${AGENT}$`),

  // ── /api/agent/:name/session/* ──────────────────────────────────────────
  new RegExp(`^/api/agent/${AGENT}/session/(message|stop|list|resume-command)$`),
  new RegExp(`^/api/agent/${AGENT}/session/[0-9a-f-]{36}/(transcript|stream|resume|open-terminal|rename|delete)$`),
];
