import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRemoteImage, isBlockedAddress } from '../src/dashboard/img-proxy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const okDeps = (over = {}) => ({
  allowHosts: ['covers.openlibrary.org'],
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],   // public
  fetchImpl: async () => ({ status: 200, headers: new Map([['content-type', 'image/png']]), body: PNG }),
  maxBytes: 5_000_000, timeoutMs: 5000, maxRedirects: 2, ...over
});

test('isBlockedAddress: private/loopback/link-local/ULA/mapped/CGNAT blocked; public ok', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.1.1', '172.16.0.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.equal(isBlockedAddress(ip), true, ip);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

test('valid https raster on allowlisted host passes', async () => {
  const r = await fetchRemoteImage('https://covers.openlibrary.org/x.png', okDeps());
  assert.equal(r.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(r.body));
});

test('rejects non-https, disallowed host, private IP, dns-rebinding, mislabeled svg, oversize', async () => {
  await assert.rejects(() => fetchRemoteImage('http://covers.openlibrary.org/x.png', okDeps()), /scheme/);
  await assert.rejects(() => fetchRemoteImage('https://evil.example/x.png', okDeps()), /host/);
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png',
    okDeps({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] })), /address/);
  // magic-byte: server says png but body is svg
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png',
    okDeps({ fetchImpl: async () => ({ status: 200, headers: new Map([['content-type', 'image/png']]), body: Buffer.from('<svg/>') }) })), /not a raster/);
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png',
    okDeps({ maxBytes: 4 })), /too large/);
});

test('redirect to a private host (not allowlisted) is rejected', async () => {
  let n = 0;
  const deps = okDeps({ fetchImpl: async () => {
    n++;
    if (n === 1) return { status: 302, headers: new Map([['location', 'https://internal.example/x.png']]), body: Buffer.alloc(0) };
    return { status: 200, headers: new Map([['content-type', 'image/png']]), body: PNG };
  }, lookup: async (host) => host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }] });
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png', deps), /host/);
});

test('redirect to an ALLOWLISTED host that resolves PRIVATE is rejected on re-vet (the real SSRF re-vet path)', async () => {
  // hop-1 host resolves public; it 302s to a second allowlisted host that
  // resolves to a private IP → must be caught by the per-hop address re-vet.
  const deps = okDeps({
    allowHosts: ['covers.openlibrary.org', 'cdn.evil-but-allowed.test'],
    fetchImpl: async (u) => u.includes('cdn.evil-but-allowed.test')
      ? { status: 200, headers: new Map([['content-type', 'image/png']]), body: PNG }            // would succeed if not re-vetted
      : { status: 302, headers: new Map([['location', 'https://cdn.evil-but-allowed.test/x.png']]), body: Buffer.alloc(0) },
    lookup: async (host) => host === 'cdn.evil-but-allowed.test'
      ? [{ address: '169.254.169.254', family: 4 }]   // link-local (cloud metadata) → must be blocked
      : [{ address: '93.184.216.34', family: 4 }]
  });
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png', deps), (e) => e.code === 'address');
});

test('numeric-literal hosts (v4 + bracketed v6) are blocked before any fetch', async () => {
  let fetched = false;
  const deps = okDeps({ fetchImpl: async () => { fetched = true; return { status: 200, headers: new Map(), body: PNG }; } });
  await assert.rejects(() => fetchRemoteImage('https://93.184.216.34/x.png', deps), (e) => e.code === 'address');
  await assert.rejects(() => fetchRemoteImage('https://[::1]/x.png', deps), (e) => e.code === 'address');
  assert.equal(fetched, false, 'no fetch on a numeric-literal host');
});
