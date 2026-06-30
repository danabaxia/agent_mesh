// Tailnet-only POST /capture: bearer auth -> validate -> durable idempotent store.
// 401 (no/bad token) · 400 (schema) · 200 (stored|duplicate) · 500 (write error, transient). ESM.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { validateCapture, makeStore } from './handler.js';

export function createCaptureServer({ token, dir, inspirationToken, inspirationFile }) {
  const store = makeStore(dir);
  return http.createServer((req, res) => {
    // Read route — least privilege: its OWN token; the capture(write) token must not read.
    if (req.method === 'GET' && req.url.split('?')[0] === '/inspiration') {
      if (!inspirationToken || (req.headers['authorization'] || '') !== `Bearer ${inspirationToken}`) return void res.writeHead(401).end();
      readFile(inspirationFile, 'utf8')
        .then((raw) => { res.writeHead(200, { 'content-type': 'application/json' }).end(raw.slice(0, 200_000)); })
        .catch(() => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"seeds":[]}'); }); // missing → empty, never 500
      return;
    }
    if (req.method !== 'POST' || req.url !== '/capture') return void res.writeHead(404).end();
    if ((req.headers['authorization'] || '') !== `Bearer ${token}`) return void res.writeHead(401).end();
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return void res.writeHead(400).end(); }
      const v = validateCapture(body);
      if (!v.ok) return void res.writeHead(v.code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: v.error }));
      try {
        store.put(v.value);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } catch {
        res.writeHead(500).end(); // transient -> caller stays pending and retries
      }
    });
  });
}
