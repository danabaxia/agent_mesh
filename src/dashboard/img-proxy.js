/**
 * src/dashboard/img-proxy.js — SSRF-hardened remote-image fetch for /api/img.
 * https-only, host allowlist, DNS-resolve + reject private addresses, PIN the
 * vetted IP for the connection (no re-resolve → no DNS rebinding), manually
 * follow <=2 redirects re-validating each hop, raster content-type + magic-byte
 * verification (reject SVG/HTML), byte + timeout caps. Pure over injected deps.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';

const RASTER = {
  'image/png':  (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif':  (b) => b.length > 6 && b.slice(0, 3).toString('latin1') === 'GIF',
  'image/webp': (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp'
};

export function isBlockedAddress(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::1') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // link-local + ULA
  let v4 = s;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) v4 = m[1];               // IPv4-mapped
  const p = v4.split('.').map(Number);
  if (p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = p;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;          // link-local
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 255) return true;                          // broadcast
    if (a >= 224) return true;                           // multicast (224-239) + reserved (240-255)
    return false;
  }
  return s !== '' && !s.includes('.'); // unknown IPv6 form → block conservatively
}

async function vet(host, deps) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    throw Object.assign(new Error('numeric-literal host blocked'), { code: 'address' });
  }
  if (!deps.allowHosts.includes(host)) throw Object.assign(new Error('host not allowlisted'), { code: 'host' });
  const addrs = await (deps.lookup || ((h) => dnsLookup(h, { all: true })))(host);
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (list.length === 0) throw Object.assign(new Error('no address resolved'), { code: 'address' });
  for (const a of list) if (isBlockedAddress(a.address)) throw Object.assign(new Error('blocked address'), { code: 'address' });
  return list[0].address; // the pinned IP
}

export async function fetchRemoteImage(url, deps) {
  const maxRedirects = deps.maxRedirects ?? 2;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') throw Object.assign(new Error('only https scheme allowed'), { code: 'scheme' });
    const pinned = await vet(u.hostname, deps);
    const res = await deps.fetchImpl(current, { pinnedAddress: pinned, hostHeader: u.hostname, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop === maxRedirects) throw Object.assign(new Error('too many redirects'), { code: 'redirect' });
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status !== 200) throw Object.assign(new Error(`upstream ${res.status}`), { code: 'upstream' });
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const check = RASTER[ct];
    if (!check) throw Object.assign(new Error('not a raster content-type'), { code: 'content_type' });
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    if (body.length > deps.maxBytes) throw Object.assign(new Error('image too large'), { code: 'too_large' });
    if (!check(body)) throw Object.assign(new Error('payload not a raster image'), { code: 'magic' });
    return { contentType: ct, body };
  }
  throw Object.assign(new Error('too many redirects'), { code: 'redirect' });
}

export function defaultPinnedFetch(url, { pinnedAddress, hostHeader, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs); to.unref?.();
    const fail = (e) => { clearTimeout(to); reject(e); };
    const req = https.request({
      host: pinnedAddress, servername: hostHeader,        // connect to the pinned IP; verify cert against the real host (SNI)
      port: u.port || 443, path: u.pathname + u.search,
      method: 'GET', headers: { host: hostHeader }, signal: ac.signal,
      rejectUnauthorized: true                            // never trust an env override (NODE_TLS_REJECT_UNAUTHORIZED=0) here
    }, (r) => {
      const chunks = []; let total = 0;
      r.on('error', fail);                                // mid-stream reset → clean reject, not an uncaught throw
      r.on('data', (c) => {
        total += c.length;
        if (maxBytes !== undefined && total > maxBytes) { // enforce the cap DURING streaming, not after
          req.destroy();
          fail(Object.assign(new Error('image too large'), { code: 'too_large' }));
          return;
        }
        chunks.push(c);
      });
      r.on('end', () => { clearTimeout(to); resolve({ status: r.statusCode, headers: new Map(Object.entries(r.headers)), body: Buffer.concat(chunks) }); });
    });
    req.on('error', fail);
    req.end();
  });
}
