import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCaptureServer } from '../src/voice-capture/server.js';

function post(port, body, token) {
  return fetch(`http://127.0.0.1:${port}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('401 without token, 200 with token, idempotent, 400 on bad schema', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const srv = createCaptureServer({ token: 'secret', dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const body = { id: 'C'.repeat(26), ts: '2026-06-27T00:00:00Z', text: 'hi', source: 'voice' };
    assert.equal((await post(port, body)).status, 401); // no token
    assert.equal((await post(port, body, 'wrong')).status, 401); // bad token
    assert.equal((await post(port, body, 'secret')).status, 200); // stored
    assert.equal((await post(port, body, 'secret')).status, 200); // duplicate still 200
    assert.equal((await post(port, { id: 'x' }, 'secret')).status, 400); // bad schema

    const lines = fs.readFileSync(path.join(dir, 'captures.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1); // idempotent: one stored note
  } finally {
    srv.close();
  }
});
