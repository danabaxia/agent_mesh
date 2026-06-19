import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry } from '../src/a2a/registry.js';

test('normalizeRegistry: HTTP peer from url field, no command needed', async () => {
  const peers = await normalizeRegistry({
    lib: { url: 'http://127.0.0.1:4747' }
  });
  assert.equal(peers.lib.type, 'http');
  assert.equal(peers.lib.url, 'http://127.0.0.1:4747');
  assert.equal(peers.lib.name, 'lib');
  assert.deepEqual(peers.lib.env, {});
});

test('normalizeRegistry: HTTP peer with env passthrough', async () => {
  const peers = await normalizeRegistry({
    lib: { url: 'http://127.0.0.1:5000', env: { SOME_KEY: 'val' } }
  });
  assert.equal(peers.lib.type, 'http');
  assert.deepEqual(peers.lib.env, { SOME_KEY: 'val' });
});

test('normalizeRegistry: stdio peer still works as before', async () => {
  const peers = await normalizeRegistry({
    worker: { command: 'node', args: ['server.js'] }
  });
  assert.equal(peers.worker.type, 'stdio');
  assert.equal(peers.worker.command, 'node');
  assert.deepEqual(peers.worker.args, ['server.js']);
});

test('normalizeRegistry: HTTP peer with https:// url is accepted', async () => {
  const peers = await normalizeRegistry({
    remote: { url: 'https://remote.example.com/a2a' }
  });
  assert.equal(peers.remote.type, 'http');
  assert.equal(peers.remote.url, 'https://remote.example.com/a2a');
});

test('normalizeRegistry: url with non-http scheme is rejected', async () => {
  await assert.rejects(
    () => normalizeRegistry({ bad: { url: 'ftp://127.0.0.1' } }),
    /url must begin with http/
  );
});

test('normalizeRegistry: peer with neither url nor command is rejected', async () => {
  await assert.rejects(
    () => normalizeRegistry({ bad: { root: '/some/path' } }),
    /requires either a url.*or a spawn command/
  );
});

test('normalizeRegistry: HTTP peer has no root or command fields', async () => {
  const peers = await normalizeRegistry({
    http_peer: { url: 'http://127.0.0.1:4747' }
  });
  assert.equal('command' in peers.http_peer, false);
  assert.equal('args' in peers.http_peer, false);
  assert.equal('root' in peers.http_peer, false);
});
