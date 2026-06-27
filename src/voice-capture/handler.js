// Mac /capture: payload validation (untrusted data) + durable-before-ok idempotent store.
// Zero-dep; ESM (matches the repo's "type":"module"). Captured text/tags/title are UNTRUSTED
// user/LLM data — bounded, validated, stored quoted as data (never executed).
import fs from 'node:fs';
import path from 'node:path';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // Crockford base32, 26 chars (matches the Python minter)

export function validateCapture(body) {
  if (!body || typeof body !== 'object') return { ok: false, code: 400, error: 'body' };
  const { id, ts, text = '', tags = [], title = '', source } = body;
  if (typeof id !== 'string' || !ULID.test(id)) return { ok: false, code: 400, error: 'id' };
  if (typeof ts !== 'string' || isNaN(Date.parse(ts))) return { ok: false, code: 400, error: 'ts' };
  if (typeof text !== 'string' || text.length > 4000) return { ok: false, code: 400, error: 'text' };
  if (typeof title !== 'string' || title.length > 200) return { ok: false, code: 400, error: 'title' };
  if (!Array.isArray(tags) || tags.length > 16 || tags.some((t) => typeof t !== 'string' || t.length > 64))
    return { ok: false, code: 400, error: 'tags' };
  if (source !== 'voice') return { ok: false, code: 400, error: 'source' };
  return { ok: true, value: { id, ts, text, tags, title, source } };
}

export function makeStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'captures.jsonl');
  const seen = new Set();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line) try { seen.add(JSON.parse(line).id); } catch { /* skip bad line */ }
    }
  }
  return {
    put(value) {
      if (seen.has(value.id)) return 'duplicate'; // idempotent on id => exactly-once storage
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, JSON.stringify({ ...value, captured_at: value.ts }) + '\n');
        fs.fsyncSync(fd); // DURABLE before we return (so the caller can drop its retry)
      } finally {
        fs.closeSync(fd);
      }
      seen.add(value.id);
      return 'stored';
    },
  };
}
