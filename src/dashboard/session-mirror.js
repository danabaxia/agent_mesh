/**
 * src/dashboard/session-mirror.js
 * Read-only live tail of a session transcript, delivered as line records
 * { seq, events:[…] } where seq = 1-based transcript line index (stable cursor).
 * Per-session ring buffer + per-subscriber cursor + replay_gap on a real hole.
 *
 * The tailer (poll/watch) is paused when no subscribers remain but the buffer is
 * kept so reconnecting clients can get a replay_gap or catchup from the ring.
 * The state is only torn down on mirror.close() or an explicit stopTail call.
 */
import { open, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { parseTranscriptLine, redactSessionEvent } from './session-events.js';

export function createSessionMirror({ pollMs = 700, bufferMax = 500, maxTailers = 32 } = {}) {
  const tailers = new Map(); // sessionId → state
  let lruClock = 0;          // monotonic recency stamp (set on each subscribe)

  // Bound the number of retained per-session ring buffers. When inserting a NEW
  // tailer would exceed the cap, evict the least-recently-used tailer that has
  // ZERO subscribers (never one with an active subscriber — that's a live stream).
  // If every tailer is busy, allow temporary growth rather than dropping a live
  // one. An evicted-then-revisited session simply rebuilds its buffer from the
  // file head on the next subscribe (correct; may emit replay_gap for a stale
  // cursor, which the frontend already handles by refetching).
  function evictIfNeeded() {
    if (tailers.size < maxTailers) return;
    let victimId = null, victimSt = null;
    for (const [id, st] of tailers) {
      if (st.subs.size > 0) continue; // never evict a tailer with a live subscriber
      if (victimSt === null || st.lru < victimSt.lru) { victimId = id; victimSt = st; }
    }
    if (victimId !== null) stopTail(victimId);
  }

  function getState(sessionId, path) {
    let st = tailers.get(sessionId);
    if (!st) {
      evictIfNeeded(); // make room before inserting a new tailer
      st = { path, subs: new Set(), buffer: [], bufferStartSeq: 1, line: 0, offset: 0, partial: '', timer: null, watcher: null, draining: false, lru: 0, primed: Promise.resolve() };
      tailers.set(sessionId, st);
    }
    st.lru = ++lruClock; // mark recency on every subscribe
    return st;
  }

  function emit(st, rec) {
    st.buffer.push(rec);
    if (st.buffer.length > bufferMax) { st.buffer.shift(); st.bufferStartSeq = st.buffer[0]?.seq ?? st.bufferStartSeq; }
    for (const fn of st.subs) { try { fn(rec); } catch { /* dead sub */ } }
  }

  async function drain(st) {
    // Re-entrancy guard: the poll timer AND the fs.watch callback both call
    // drain(); without this, two overlapping runs read the same byte range
    // before st.offset advances → every line emitted twice.
    if (st.draining) return;
    st.draining = true;
    try {
      const fh = await open(st.path, 'r');
      try {
        const s = await fh.stat();
        if (s.size < st.offset) { // truncation/rotation → reset + gap
          st.offset = 0; st.line = 0; st.partial = ''; st.buffer = []; st.bufferStartSeq = 1; st.rotated = true;
          for (const fn of st.subs) { try { fn({ type: 'replay_gap' }); } catch { /* ignore */ } }
        }
        if (s.size <= st.offset) return;
        const len = s.size - st.offset;
        const buf = Buffer.allocUnsafe(len); // immediately filled by read; no need to zero
        await fh.read(buf, 0, len, st.offset);
        st.offset = s.size;
        st.partial += buf.toString('utf8');
        const parts = st.partial.split('\n');
        st.partial = parts.pop() ?? '';
        for (const line of parts) {
          st.line += 1;
          if (!line.trim()) continue;
          const events = parseTranscriptLine(line).map(redactSessionEvent);
          if (events.length) emit(st, { seq: st.line, events });
        }
      } finally { await fh.close(); }
    } catch (err) {
      // ignore read/open errors (e.g. file busy or not yet created)
    } finally {
      st.draining = false;
    }
  }

  async function primeAtEof(st, line) {
    if (st.draining) return;
    st.draining = true;
    try {
      const s = await stat(st.path);
      st.offset = s.size;
      st.line = Math.max(0, Math.floor(Number(line) || 0));
      st.buffer = [];
      st.bufferStartSeq = st.line + 1;
      st.partial = '';
    } catch {
      // If the file is not readable yet, fall back to normal drain behavior.
      st.offset = 0;
      st.line = 0;
    } finally {
      st.draining = false;
    }
  }

  function startTail(st, { fastForward = false, lastSeq = 0 } = {}) {
    try { st.watcher = watch(st.path, () => drain(st)); st.watcher.on?.('error', () => {}); } catch { /* poll covers it */ }
    st.timer = setInterval(() => drain(st), pollMs); st.timer.unref?.();
    // Capture the INITIAL drain as a promise so subscribe() can await the file
    // being read to current EOF before it makes its replay-vs-gap decision and
    // before it adds the subscriber. Without this, a fresh tailer (line=0,
    // empty buffer) would false-gap a cursor>0 and double-deliver the existing
    // records the initial drain fans out. For a paused-then-revisited tailer,
    // this drain reads from the preserved offset to EOF (picking up appends made
    // while paused) — awaiting it is correct. For an already-running tailer this
    // path isn't hit, so st.primed keeps its prior (resolved) promise.
    const canFastForward = fastForward && lastSeq > 0 && st.offset === 0 && st.line === 0 && st.buffer.length === 0;
    st.primed = canFastForward ? primeAtEof(st, lastSeq) : drain(st);
  }

  function pauseTail(st) {
    // Stop the timer/watcher but keep the state + buffer alive for reconnects.
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.watcher) { try { st.watcher.close(); } catch { /* ignore */ } st.watcher = null; }
  }

  function stopTail(sessionId) {
    const st = tailers.get(sessionId); if (!st) return;
    pauseTail(st);
    tailers.delete(sessionId);
  }

  async function subscribe(sessionId, transcriptPath, fn, lastSeq = 0, opts = {}) {
    const st = getState(sessionId, transcriptPath);
    // Ensure the tailer is running (start or restart if it was paused). For the
    // dashboard's lazy initial view, fastForward skips parsing existing history
    // and starts tailing at EOF; explicit history loads use /transcript instead.
    if (!st.timer) startTail(st, { fastForward: !!opts.fastForward, lastSeq });
    // Wait for the tailer's initial drain to read the file to current EOF before
    // deciding replay-vs-gap and before adding the subscriber. This is what seals
    // the past→live handoff: st.line / st.buffer / st.bufferStartSeq now reflect
    // reality, so a cursor at EOF neither false-gaps nor re-delivers what's already
    // rendered. Drain errors are non-fatal (file gone/unreadable) — treat as empty.
    try { await st.primed; } catch { /* non-fatal; proceed with whatever state we have */ }
    // replay decision. Gap when: (a) the requested cursor is older than the
    // buffer (`lastSeq+1 < bufferStartSeq`), or (b) the cursor is AHEAD of the
    // current file (`lastSeq > st.line`) — which means the transcript was
    // truncated/rotated under the client (its old seq no longer exists), so we
    // must force a full reload rather than silently deliver nothing.
    let hi = lastSeq; // highest seq replayed; used for the await-window catch-up
    if (lastSeq + 1 < st.bufferStartSeq || lastSeq > st.line) {
      try { fn({ type: 'replay_gap' }); } catch { /* ignore */ }
    } else {
      for (const rec of st.buffer) if (rec.seq > lastSeq) { try { fn(rec); } catch { /* ignore */ }; hi = rec.seq; }
    }
    st.subs.add(fn); // add AFTER replay so the initial drain's emits don't bypass the cursor
    // Await-window catch-up: between `await st.primed` and `st.subs.add(fn)`, a
    // concurrently-running poll/watch drain could have emit()'d a NEW record. Since
    // fn wasn't in st.subs yet, that record landed in the buffer but was not
    // delivered live to this subscriber — and the replay loop above already ran, so
    // it would be missed. Replay any buffer records that arrived past `hi` once
    // more now that fn is subscribed. Dedup is by seq monotonicity (seq > hi).
    if (!(lastSeq + 1 < st.bufferStartSeq || lastSeq > st.line)) {
      for (const rec of st.buffer) if (rec.seq > hi) { try { fn(rec); } catch { /* ignore */ } }
    }
    return {
      close: () => {
        st.subs.delete(fn);
        // Pause the tailer when idle (no subscribers), but keep the buffer.
        if (st.subs.size === 0) pauseTail(st);
      }
    };
  }

  function close() { for (const id of [...tailers.keys()]) stopTail(id); }

  return { subscribe, close };
}
