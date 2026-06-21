import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_PATTERNS } from '../src/dashboard/routes-manifest.js';

// Representative resolved client URLs (path only, no query string).
// Sourced from: src/dashboard/public/*.js fetch() / EventSource() calls.
// Per-agent routes use a representative agent name 'lib'.
const CLIENT_URLS = [
  // board2.js
  '/api/activity',
  '/api/collab',
  '/api/events',
  '/api/mesh',
  '/api/resources',
  '/api/usage',

  // graph-view.js
  '/api/activity-log',
  '/api/ci-schedules',
  '/api/daily',
  '/api/daily/refresh',
  '/api/health',
  '/api/merge-sweep',
  '/api/schedules',
  '/api/schedules/run',
  '/api/tokens',

  // activity-tab.js
  '/api/agent/lib/activity-stats',

  // artifacts-tab.js
  '/api/agent/lib/artifacts',
  '/api/agent/lib/artifact/some-slug',
  '/api/agent/lib/workflows',

  // files-tab.js
  '/api/agent/lib/deliverables',
  '/api/agent/lib/deliverable/locate',

  // workflows-tab.js
  '/api/agent/lib/workflow/some-slug',
  '/api/agent/lib/session/message',

  // schedule-tab.js
  '/api/agent/lib/schedule',
  '/api/agent/lib/schedule/some-id/run',
  '/api/agent/lib/schedule/some-id/enable',
  '/api/agent/lib/schedule/some-id',

  // session-log.js / session-view.js (via api() helper → /api/agent/:name + suffix)
  '/api/agent/lib/session/list',
  '/api/agent/lib/session/resume-command',
  '/api/agent/lib/session/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/transcript',
  '/api/agent/lib/session/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/stream',
  '/api/agent/lib/session/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/open-terminal',
  '/api/agent/lib/session/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/rename',
  '/api/agent/lib/session/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/delete',

  // session-log.js terminalLaunchRequest path (shell)
  '/api/agent/lib/shell/plan',
  '/api/agent/lib/shell/launch',
];

test('every client URL matches a manifest route pattern', () => {
  const unmatched = CLIENT_URLS.filter((u) => !ROUTE_PATTERNS.some((re) => re.test(u.split('?')[0])));
  assert.deepEqual(unmatched, [], `client URLs with no server route pattern: ${unmatched.join(', ')}`);
});
