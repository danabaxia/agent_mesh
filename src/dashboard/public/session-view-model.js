// session-view-model.js — PURE, DOM-free, deterministic helpers extracted
// verbatim from session-view.js so the session-tab logic can be unit-tested
// without a DOM. No Date/locale (those formatters stay in the view), no fetch,
// no random — just data → data.

/** ①…⑳ then #N — port of the reference generator's circ(). */
export function circ(n) {
  return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : '#' + n;
}

/** Truncate `s` to `n` chars with a trailing " …" when it overflows. */
export function preview(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + ' …' : s;
}

/** Cap a string at `max` UTF-8 bytes (artifact embed limit). */
export function capUtf8(s, max) {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(s.slice(0, mid)).length <= max) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/**
 * Rebuild minimal raw-shaped JSONL records from the server's redacted envelope
 * events, in seq order, so groupTurns() (which expects raw record shapes)
 * applies unchanged. Sidechain events are skipped here (out of Phase-7 scope);
 * tool_result / raw events are not part of turn grouping.
 */
export function rawFromRecords(records) {
  const raw = [];
  for (const rec of records || []) {
    for (const ev of rec.events || []) {
      if (!ev || ev.sidechain === true) continue;
      const ts = typeof ev.ts === 'string' ? ev.ts : '';
      if (ev.type === 'user_text') {
        raw.push({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text: ev.text }] } });
      } else if (ev.type === 'text') {
        raw.push({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: ev.text }] } });
      } else if (ev.type === 'tool_use') {
        raw.push({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: ev.name, input: ev.input }] } });
      }
    }
  }
  return raw;
}
