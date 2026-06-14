/**
 * src/dashboard/session-live.js
 *
 * In-memory live records for dashboard-managed Claude turns. Claude Code 2.1.x
 * may checkpoint ~/.claude/projects transcripts instead of appending every live
 * turn, so transcript tailing alone cannot drive the canvas in real time. This
 * hub carries the runner's stream-json records until the checkpointed transcript
 * catches up.
 */
import { redactSessionEvent } from './session-events.js';

export function createSessionLive({ bufferMax = 500 } = {}) {
  const sessions = new Map();

  function state(sessionId) {
    let st = sessions.get(sessionId);
    if (!st) {
      st = { seq: 0, buffer: [], bufferStartSeq: 1, subs: new Set() };
      sessions.set(sessionId, st);
    }
    return st;
  }

  function start(sessionId, { baseSeq = 0 } = {}) {
    const st = state(sessionId);
    if (Number.isFinite(baseSeq) && baseSeq > st.seq) {
      st.seq = Math.floor(baseSeq);
      st.bufferStartSeq = Math.max(st.bufferStartSeq, st.seq + 1);
    }
    return {
      append(events) { append(sessionId, events); }
    };
  }

  function append(sessionId, events) {
    const clean = (Array.isArray(events) ? events : [events])
      .filter(Boolean)
      .map(redactSessionEvent);
    if (clean.length === 0) return null;
    const st = state(sessionId);
    const rec = { seq: ++st.seq, events: clean };
    st.buffer.push(rec);
    if (st.buffer.length > bufferMax) {
      st.buffer.shift();
      st.bufferStartSeq = st.buffer[0]?.seq ?? (st.seq + 1);
    }
    for (const fn of st.subs) {
      try { fn(rec); } catch { /* dead subscriber */ }
    }
    return rec;
  }

  function window(sessionId, { beforeSeq = Infinity, limit = 200 } = {}) {
    const st = sessions.get(sessionId);
    if (!st) return [];
    const before = Number.isFinite(beforeSeq) ? beforeSeq : Infinity;
    const cap = Math.max(1, Math.min(500, Number(limit) || 200));
    return st.buffer.filter((r) => r.seq < before).slice(-cap);
  }

  function subscribe(sessionId, fn, lastSeq = 0) {
    const st = state(sessionId);
    const last = Math.max(0, Math.floor(Number(lastSeq) || 0));
    if (last + 1 < st.bufferStartSeq && st.buffer.length > 0) {
      try { fn({ type: 'replay_gap' }); } catch { /* ignore */ }
    } else {
      for (const rec of st.buffer) {
        if (rec.seq > last) {
          try { fn(rec); } catch { /* ignore */ }
        }
      }
    }
    st.subs.add(fn);
    return {
      close() { st.subs.delete(fn); }
    };
  }

  function close() {
    sessions.clear();
  }

  return { start, append, window, subscribe, close };
}
