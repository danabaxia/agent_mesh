import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createCaptureServer } from '../src/voice-capture/server.js';

async function boot(opts) {
  const srv = createCaptureServer(opts);
  srv.listen(0); await once(srv, 'listening');
  return { srv, port: srv.address().port };
}
const get = (port, token) => fetch(`http://127.0.0.1:${port}/inspiration`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('GET /inspiration returns the digest with the read token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insp-'));
  const file = join(dir, 'inspiration.json');
  writeFileSync(file, JSON.stringify({ generatedAt: 'x', seeds: [{ theme: 't', spark: 's' }] }));
  const { srv, port } = await boot({ token: 'WRITE', dir, inspirationToken: 'READ', inspirationFile: file });
  const r = await get(port, 'READ');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).seeds[0].spark, 's');
  srv.close();
});

test('the capture WRITE token does NOT grant read (401)', async () => {
  const { srv, port } = await boot({ token: 'WRITE', dir: '/tmp', inspirationToken: 'READ', inspirationFile: '/tmp/none.json' });
  assert.equal((await get(port, 'WRITE')).status, 401);
  srv.close();
});

test('missing digest file → {seeds:[]}, never 500', async () => {
  const { srv, port } = await boot({ token: 'WRITE', dir: '/tmp', inspirationToken: 'READ', inspirationFile: '/tmp/does-not-exist.json' });
  const r = await get(port, 'READ');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { seeds: [] });
  srv.close();
});
