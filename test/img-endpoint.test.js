import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function mesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'img-'));
  await initMesh(meshRoot);
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [] });
  return meshRoot;
}
async function authed(meshRoot, opts) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

test('/api/img disabled without --allow-shell → 403', async () => {
  const meshRoot = await mesh();
  const { srv, port, cookie } = await authed(meshRoot, {});
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://covers.openlibrary.org/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});

test('/api/img enabled (injected fetcher) → streams raster + nosniff', async () => {
  const meshRoot = await mesh();
  const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
  const imgFetcher = async () => ({ contentType: 'image/png', body: PNG });
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, imgFetcher });
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://covers.openlibrary.org/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await srv.close(); }
});

test('/api/img rejection (injected fetcher throws) → 4xx code', async () => {
  const meshRoot = await mesh();
  const imgFetcher = async () => { throw Object.assign(new Error('host not allowlisted'), { code: 'host' }); };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, imgFetcher });
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://evil.example/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'host');
  } finally { await srv.close(); }
});

test('/api/img coerces Node-internal errors to a generic code (no getaddrinfo/ERR_* leak)', async () => {
  const meshRoot = await mesh();
  // a fetcher that throws a Node-internal style error (as new URL("")/DNS would)
  const imgFetcher = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND covers.openlibrary.org'), { code: 'ENOTFOUND' }); };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, imgFetcher });
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://covers.openlibrary.org/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.code, 'img_error');                 // coerced, not ENOTFOUND
    assert.equal(j.error.message, 'image request failed');    // no getaddrinfo leak
  } finally { await srv.close(); }
});
