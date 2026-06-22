import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAlerts, syncAlerts } from '../src/concierge/alerts-store.js';

test('missing store → empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'al-'));
  assert.deepEqual(await readAlerts(root), { alerts: [], updatedAt: null });
});

test('sync upserts, preserves firstSeen, resolves cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'al-'));
  const f1 = { id: 'a', severity: 'warn', kind: 'k', summary: 's', detail: '', source: 'x' };
  await syncAlerts(root, [f1], '2026-06-21T10:00:00Z');
  await syncAlerts(root, [f1], '2026-06-21T11:00:00Z');           // still present
  let { alerts } = await readAlerts(root);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].firstSeen, '2026-06-21T10:00:00Z');     // preserved
  assert.equal(alerts[0].lastSeen, '2026-06-21T11:00:00Z');      // updated
  await syncAlerts(root, [], '2026-06-21T12:00:00Z');            // cleared
  ({ alerts } = await readAlerts(root));
  assert.equal(alerts.length, 0, 'resolved when no longer present');
});
