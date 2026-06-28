import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCaptureServer } from '../src/voice-capture/serve-capture-cmd.js';

test('buildCaptureServer requires MAC_CAPTURE_TOKEN', () => {
  assert.throws(() => buildCaptureServer([], {}), /MAC_CAPTURE_TOKEN/);
});

test('buildCaptureServer returns a server bound 127.0.0.1 with dir from arg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cli-'));
  const built = buildCaptureServer([dir], { MAC_CAPTURE_TOKEN: 'secret' });
  assert.ok(built.server instanceof http.Server);
  assert.equal(built.host, '127.0.0.1');
  assert.equal(built.dir, dir);
  assert.equal(built.port, 8787);                 // default port
  built.server.close();
});

test('buildCaptureServer honors CAPTURE_PORT and CAPTURE_DIR env', () => {
  const built = buildCaptureServer([], { MAC_CAPTURE_TOKEN: 's', CAPTURE_PORT: '9999', CAPTURE_DIR: '/tmp/capdir' });
  assert.equal(built.port, 9999);
  assert.equal(built.dir, '/tmp/capdir');
  built.server.close();
});

test('CAPTURE_HOST widens the bind (default stays loopback)', () => {
  const def = buildCaptureServer([], { MAC_CAPTURE_TOKEN: 's' });
  assert.equal(def.host, '127.0.0.1');
  def.server.close();
  const lan = buildCaptureServer([], { MAC_CAPTURE_TOKEN: 's', CAPTURE_HOST: '0.0.0.0' });
  assert.equal(lan.host, '0.0.0.0');
  lan.server.close();
});
