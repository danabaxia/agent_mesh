# Windows Voice Server MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hands-free streaming voice server on the Windows RTX 3060 that captures spoken ideas with deterministic durability (never lost) and syncs them to the Mac mesh.

**Architecture:** Phone (WebRTC client) → Windows voice-agent (LiveKit SFU + faster-whisper STT + Gemini brain + Kokoro TTS, **capture-first** so durability never depends on the LLM/STT) → local SQLite(WAL) outbox → background syncer → Mac `/capture` sink, all over Tailscale. The turn loop commits the raw turn to the outbox *before* STT or the LLM run.

**Tech Stack:** Python 3.10+ (LiveKit Agents, faster-whisper, Kokoro, stdlib `sqlite3`/`unittest`) on the Windows/WSL2 side; Node ≥20 (zero-dep, `node --test`) for the Mac `/capture` endpoint; vanilla-JS PWA for the phone; Tailscale; WSL2 + CUDA.

## Global Constraints

- **Capture-first durability invariant:** every turn is committed to the outbox (`state=captured`) BEFORE STT or the LLM run; the LLM/STT only enrich, never gate durability. (spec §5)
- **Truthful confirmation:** the agent says "noted, syncing" — never "saved" — until the Mac ack. (spec §8)
- **Untrusted data:** `text`/`tags`/`title` are length-bounded, schema-validated, stored quoted as data, never executed; rate-limited; audited. (spec §8, §6 sibling)
- **Outbox failure split:** transient (offline / network / 5xx / 429) → `pending` **indefinitely** + retry; **dead only for permanent 4xx (schema/auth)**. (spec §9)
- **Mac `/capture`:** returns `200` ONLY after a durable (`fsync`'d) write; **idempotent on `id` (ULID)**; `400`/`401`/`403` = permanent, `429`/`5xx` = transient. (sibling spec §3–§5)
- **WebRTC auth:** room-scoped JWT, ~60s TTL, microphone-only publish, `maxParticipants=1`, second-join rejected. (spec §7)
- **Networking:** `tailscaled` on the Windows host, NOT in WSL2 (MTU 1280); media = direct tailnet UDP, never `tailscale serve`; DERP-only → degrade explicitly, never silent TCP media. (spec §6)
- **Platform prereq:** Windows 11 22H2+ enables the mirrored-networking primary; else native-SFU fallback. (spec §17)
- **Zero-dep posture:** Python side uses only the stdlib (`sqlite3`, `unittest`, `http`, `json`, `urllib`); the Mac side uses only `node --test`. No new third-party deps except the unavoidable voice stack (livekit-agents, faster-whisper, kokoro).
- **Repo layout:** new `voice-server/` (Python) for the Windows side; Mac `/capture` lives under the agent_mesh Node tree; the old `voice-demo/` is superseded (left in place, not extended).

---

## Phase 0 — De-risk spikes (GATING; hardware-in-the-loop, not TDD)

Each spike is a throwaway that answers one question against an explicit pass bar. **Do not proceed to Phase 1 until all three pass (or their fallbacks are chosen).** Record results in `voice-server/SPIKES.md`.

### Task 0.1: Spike-3 — LiveKit self-host standup (do first; unblocks 0.1/0.2 wiring)

**Files:**
- Create: `voice-server/spikes/spike3_livekit/README.md` (commands + result)
- Create: `voice-server/SPIKES.md` (results ledger)

- [ ] **Step 1: Install LiveKit server in WSL2.** Run:
```bash
curl -sSL https://get.livekit.io | bash      # installs `livekit-server`
livekit-server --version
```
- [ ] **Step 2: Run a dev LiveKit server bound to all interfaces.** Run:
```bash
livekit-server --dev --bind 0.0.0.0          # prints an API key/secret in dev mode
```
Expected: server listens (default `:7880` TCP signaling, a UDP range for media).
- [ ] **Step 3: Install the Agents SDK + run the example echo agent.** Run:
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install "livekit-agents>=0.10"           # the only voice-stack dep so far
python -m livekit.agents.examples.minimal_worker  # or the SDK's quickstart worker
```
- [ ] **Step 4: Join from a browser on the same machine** (LiveKit Agents playground or a `localhost` test page) and confirm one end-to-end audio round trip.
- [ ] **Step 5: Record the verdict in `SPIKES.md`.** PASS bar: a browser↔agent audio round trip works locally. Capture the UDP port range LiveKit used (needed for §6 firewall rules).

### Task 0.2: Spike-1 — media plane over Tailscale (R2′: mirrored vs native)

**Files:** `voice-server/spikes/spike1_media/README.md`, append to `SPIKES.md`

- [ ] **Step 1: Confirm the platform.** Run `wsl.exe --version` and Windows `winver`. Record whether the box is **Windows 11 22H2+** (mirrored primary) or older (native fallback forced).
- [ ] **Step 2 (primary): enable WSL2 mirrored networking.** In `%UserProfile%\.wslconfig`:
```ini
[wsl2]
networkingMode=mirrored
```
Then `wsl --shutdown` and restart. Verify WSL2 shares host interfaces: inside WSL2 `ip addr` shows the host's tailnet IP (`100.x` / `*.ts.net`).
- [ ] **Step 3: Open the LiveKit UDP port range** (from Spike-3) in the Windows Defender Firewall (inbound, UDP, those ports) and confirm `tailscaled` runs on the **host** (`tailscale status` on Windows).
- [ ] **Step 4: From a phone on cellular (off-LAN) AND on home Wi-Fi, join the LiveKit room** and run an audio round trip. For each, run on the host `tailscale ping <phone>` and record `direct` vs `via DERP`.
- [ ] **Step 5: Measure** one-way audio latency + subjective jitter for: (a) on-LAN direct, (b) off-LAN. If off-LAN is DERP-only, test designating the Mac as a **peer relay** and re-measure.
- [ ] **Step 6 (fallback only): if mirrored fails,** run `livekit-server` as a **native Windows process**, keep inference in WSL2, bridge over `localhost`, and measure the hypervisor-bridge added latency.
- [ ] **Step 7: Verdict in `SPIKES.md`.** PASS bar: on-LAN audio is clean and **direct** (not DERP); off-LAN is usable (peer-relay acceptable). **Decision recorded: mirrored or native** — this drives Phase 6 wiring.

### Task 0.3: Spike-2 — faster-whisper + StreamAdapter latency

**Files:** `voice-server/spikes/spike2_stt/measure.py`, append to `SPIKES.md`

- [ ] **Step 1: Install + verify CUDA faster-whisper.** Run:
```bash
pip install faster-whisper
python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cuda', compute_type='int8'); print('cuda ok')"
```
- [ ] **Step 2: Write `measure.py`** that feeds 3 real recorded turn-length clips (~3s, ~6s, ~10s) through faster-whisper and prints transcribe wall-time per clip.
```python
import sys, time
from faster_whisper import WhisperModel
m = WhisperModel("small", device="cuda", compute_type="int8")
for path in sys.argv[1:]:
    t = time.perf_counter()
    segs, _ = m.transcribe(path, vad_filter=True)
    text = " ".join(s.text for s in segs)
    print(f"{path}: {time.perf_counter()-t:.2f}s  -> {text[:60]!r}")
```
- [ ] **Step 3: Run it warm** (second run, model resident): `python measure.py clip3s.wav clip6s.wav clip10s.wav`.
- [ ] **Step 4: Wrap in LiveKit's VAD + StreamAdapter** per the Agents STT docs and confirm interim/final events fire from buffered segments (this is the real integration, not a bare clip).
- [ ] **Step 5: Verdict in `SPIKES.md`.** PASS bar: warm STT for a typical (~6s) turn ≤ ~700ms (leaves room under the ~2s turn budget). **If it misses the bar → record the decision to swap to a truly streaming STT** (e.g. whisper-streaming) before Phase 4.

---

## Phase 1 — Outbox (Python, SQLite WAL, full TDD) — the durability core

### Task 1: Outbox store + state machine

**Files:**
- Create: `voice-server/outbox.py`
- Test: `voice-server/test_outbox.py`

**Interfaces:**
- Produces: `Outbox(db_path)` with `capture(audio_ref:str, ts:str) -> str` (returns ULID `id`, writes `state="captured"`), `attach_transcript(id, text)`, `attach_enrichment(id, dict)`, `mark(id, state)`, `get(id) -> dict|None`, `pending() -> list[dict]`. States: `captured|enriched|syncing|synced|dead`.

- [ ] **Step 1: Write the failing test for capture + read-back.**
```python
import os, tempfile, unittest
from outbox import Outbox

class TestOutbox(unittest.TestCase):
    def setUp(self):
        self.db = os.path.join(tempfile.mkdtemp(), "o.db")
        self.ob = Outbox(self.db)
    def test_capture_returns_ulid_and_persists_captured(self):
        rid = self.ob.capture(audio_ref="/a/seg1.wav", ts="2026-06-27T00:00:00Z")
        self.assertEqual(len(rid), 26)                 # ULID length
        rec = self.ob.get(rid)
        self.assertEqual(rec["state"], "captured")
        self.assertEqual(rec["audio_ref"], "/a/seg1.wav")
        self.assertIsNone(rec["transcript"])

if __name__ == "__main__":
    unittest.main()
```
- [ ] **Step 2: Run it, verify it fails.** Run: `cd voice-server && python -m unittest test_outbox -v`
Expected: FAIL (`ModuleNotFoundError: outbox` / `AttributeError`).
- [ ] **Step 3: Implement `outbox.py` minimally.**
```python
import sqlite3, secrets, time

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
def _ulid() -> str:
    # 26-char Crockford base32; monotonic-enough for a single writer (time + random)
    ms = int(time.time() * 1000)
    rnd = secrets.randbits(80)
    n = (ms << 80) | rnd
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[n & 31]); n >>= 5
    return "".join(reversed(out))

_DDL = """
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, audio_ref TEXT,
  transcript TEXT, enrichment TEXT,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
"""
class Outbox:
    def __init__(self, db_path: str):
        self.c = sqlite3.connect(db_path, isolation_level=None)  # autocommit; we manage txns
        self.c.execute("PRAGMA journal_mode=WAL")
        self.c.execute("PRAGMA synchronous=FULL")                # durability over speed
        self.c.execute(_DDL)
    def capture(self, audio_ref: str, ts: str) -> str:
        rid = _ulid()
        self.c.execute("INSERT INTO outbox(id,ts,audio_ref,state) VALUES(?,?,?, 'captured')",
                       (rid, ts, audio_ref))
        return rid
    def get(self, rid: str):
        row = self.c.execute("SELECT id,ts,audio_ref,transcript,enrichment,state,attempts,last_error"
                             " FROM outbox WHERE id=?", (rid,)).fetchone()
        if not row: return None
        keys = ["id","ts","audio_ref","transcript","enrichment","state","attempts","last_error"]
        return dict(zip(keys, row))
```
- [ ] **Step 4: Run the test, verify it passes.** Run: `python -m unittest test_outbox -v` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add voice-server/outbox.py voice-server/test_outbox.py
git commit -m "feat(voice): outbox capture + SQLite WAL store"
```

### Task 2: Outbox enrichment + state transitions

**Files:** Modify `voice-server/outbox.py`; Test `voice-server/test_outbox.py`

**Interfaces:** Consumes Task 1 `Outbox`. Produces `attach_transcript`, `attach_enrichment`, `mark`, `pending`.

- [ ] **Step 1: Write the failing test.**
```python
    def test_enrich_and_pending_lists_unsynced(self):
        rid = self.ob.capture("/a/s.wav", "2026-06-27T00:00:00Z")
        self.ob.attach_transcript(rid, "buy milk")
        self.ob.attach_enrichment(rid, {"tags": ["errand"]})
        self.assertEqual(self.ob.get(rid)["transcript"], "buy milk")
        self.assertIn(rid, [r["id"] for r in self.ob.pending()])
        self.ob.mark(rid, "synced")
        self.assertNotIn(rid, [r["id"] for r in self.ob.pending()])
```
- [ ] **Step 2: Run, verify it fails** (`AttributeError: attach_transcript`).
- [ ] **Step 3: Implement the methods.**
```python
import json
    def attach_transcript(self, rid, text):
        self.c.execute("UPDATE outbox SET transcript=?, state=CASE WHEN state='captured' THEN 'enriched' ELSE state END WHERE id=?", (text, rid))
    def attach_enrichment(self, rid, d):
        self.c.execute("UPDATE outbox SET enrichment=? WHERE id=?", (json.dumps(d), rid))
    def mark(self, rid, state, err=None):
        self.c.execute("UPDATE outbox SET state=?, last_error=? WHERE id=?", (state, err, rid))
    def pending(self):
        rows = self.c.execute("SELECT id,ts,audio_ref,transcript,enrichment,state,attempts,last_error"
                              " FROM outbox WHERE state NOT IN ('synced','dead') ORDER BY id").fetchall()
        keys = ["id","ts","audio_ref","transcript","enrichment","state","attempts","last_error"]
        return [dict(zip(keys, r)) for r in rows]
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(voice): outbox enrichment + pending/mark transitions"`

### Task 3: Crash-recovery reconciliation (WAL + stuck `syncing`)

**Files:** Modify `voice-server/outbox.py`; Test `voice-server/test_outbox.py`

**Interfaces:** Produces `Outbox.reconcile_on_start()` — any record left in `syncing` (crash mid-sync) reverts to its enriched/captured state for safe retry.

- [ ] **Step 1: Write the failing test.**
```python
    def test_reconcile_reverts_stuck_syncing(self):
        rid = self.ob.capture("/a/s.wav", "t"); self.ob.mark(rid, "syncing")
        del self.ob                                   # simulate crash (drop handle)
        from outbox import Outbox
        ob2 = Outbox(self.db); ob2.reconcile_on_start()
        self.assertEqual(ob2.get(rid)["state"], "captured")
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement.**
```python
    def reconcile_on_start(self):
        # crash mid-sync leaves 'syncing'; revert so the syncer retries (idempotent on Mac side)
        self.c.execute("UPDATE outbox SET state=CASE WHEN transcript IS NULL THEN 'captured' ELSE 'enriched' END"
                       " WHERE state='syncing'")
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(voice): outbox crash-recovery reconcile"`

---

## Phase 2 — Mac `/capture` endpoint (Node, zero-dep, full TDD) — the sink

### Task 4: Capture handler — schema validation + bounds (pure)

**Files:**
- Create: `src/voice-capture/handler.js`
- Test: `test/voice-capture-handler.test.js`

**Interfaces:** Produces `validateCapture(body) -> {ok:true, value} | {ok:false, code:400, error}`. Bounds: `id` 26-char ULID, `text` ≤ 4000 chars, `tags` ≤ 16 items each ≤ 64 chars, `ts` ISO-8601, `source` in {"voice"}.

- [ ] **Step 1: Write the failing test.**
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { validateCapture } = require('../src/voice-capture/handler.js');

test('valid payload passes', () => {
  const r = validateCapture({ id: 'A'.repeat(26), ts: '2026-06-27T00:00:00Z', text: 'buy milk', source: 'voice' });
  assert.equal(r.ok, true);
  assert.equal(r.value.text, 'buy milk');
});
test('oversize text is rejected 400', () => {
  const r = validateCapture({ id: 'A'.repeat(26), ts: '2026-06-27T00:00:00Z', text: 'x'.repeat(4001), source: 'voice' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});
test('bad id length rejected', () => {
  const r = validateCapture({ id: 'short', ts: '2026-06-27T00:00:00Z', text: 'hi', source: 'voice' });
  assert.equal(r.ok, false);
});
```
- [ ] **Step 2: Run, verify it fails.** Run: `node --test test/voice-capture-handler.test.js`
Expected: FAIL (cannot find module).
- [ ] **Step 3: Implement `handler.js`.**
```javascript
'use strict';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function validateCapture(body) {
  if (!body || typeof body !== 'object') return { ok: false, code: 400, error: 'body' };
  const { id, ts, text = '', tags = [], title = '', source } = body;
  if (typeof id !== 'string' || !ULID.test(id)) return { ok: false, code: 400, error: 'id' };
  if (typeof ts !== 'string' || isNaN(Date.parse(ts))) return { ok: false, code: 400, error: 'ts' };
  if (typeof text !== 'string' || text.length > 4000) return { ok: false, code: 400, error: 'text' };
  if (typeof title !== 'string' || title.length > 200) return { ok: false, code: 400, error: 'title' };
  if (!Array.isArray(tags) || tags.length > 16 || tags.some(t => typeof t !== 'string' || t.length > 64))
    return { ok: false, code: 400, error: 'tags' };
  if (source !== 'voice') return { ok: false, code: 400, error: 'source' };
  return { ok: true, value: { id, ts, text, tags, title, source } };
}
module.exports = { validateCapture };
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git add src/voice-capture/handler.js test/voice-capture-handler.test.js && git commit -m "feat(capture): payload validation + bounds"`

### Task 5: Durable store — durable-before-ok + idempotency (pure)

**Files:** Modify `src/voice-capture/handler.js`; Test `test/voice-capture-handler.test.js`

**Interfaces:** Produces `makeStore(dir)` → `{ put(value) -> 'stored'|'duplicate' }` that `fsync`s an append before returning; a repeat `id` returns `'duplicate'` and writes nothing.

- [ ] **Step 1: Write the failing test.**
```javascript
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeStore } = require('../src/voice-capture/handler.js');

test('put is durable and idempotent on id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const store = makeStore(dir);
  const v = { id: 'B'.repeat(26), ts: '2026-06-27T00:00:00Z', text: 'idea', tags: [], title: '', source: 'voice' };
  assert.equal(store.put(v), 'stored');
  assert.equal(store.put(v), 'duplicate');                 // same id → no second write
  const lines = fs.readFileSync(path.join(dir, 'captures.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"text":"idea"/);
});
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement `makeStore` (append + fsync + in-file id index).**
```javascript
const fs = require('node:fs');
const path = require('node:path');
function makeStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'captures.jsonl');
  const seen = new Set();
  if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n'))
    { if (l) try { seen.add(JSON.parse(l).id); } catch {} }
  return {
    put(value) {
      if (seen.has(value.id)) return 'duplicate';
      const fd = fs.openSync(file, 'a');
      try { fs.writeSync(fd, JSON.stringify({ ...value, captured_at: value.ts }) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      seen.add(value.id);
      return 'stored';
    },
  };
}
module.exports = { validateCapture, makeStore };   // extend existing export
```
- [ ] **Step 4: Run, verify PASS** (both Task 4 and Task 5 tests).
- [ ] **Step 5: Commit.** `git commit -am "feat(capture): durable-before-ok store, idempotent on id"`

### Task 6: HTTP endpoint — auth + status mapping (tailnet-only)

**Files:**
- Create: `src/voice-capture/server.js`
- Test: `test/voice-capture-server.test.js`

**Interfaces:** Consumes `validateCapture`, `makeStore`. Produces `createCaptureServer({ token, dir }) -> http.Server`. Routes `POST /capture`: missing/bad token → 401; `validateCapture` fail → 400; store `stored`/`duplicate` → 200; bind `127.0.0.1`.

- [ ] **Step 1: Write the failing test (spin the server on an ephemeral port).**
```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createCaptureServer } = require('../src/voice-capture/server.js');

function post(port, body, token) {
  return fetch(`http://127.0.0.1:${port}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
test('401 without token, 200 with token + idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const srv = createCaptureServer({ token: 'secret', dir });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const body = { id: 'C'.repeat(26), ts: '2026-06-27T00:00:00Z', text: 'hi', source: 'voice' };
  assert.equal((await post(port, body)).status, 401);
  assert.equal((await post(port, body, 'secret')).status, 200);
  assert.equal((await post(port, body, 'secret')).status, 200);   // duplicate still 200
  assert.equal((await post(port, { id: 'x' }, 'secret')).status, 400);
  srv.close();
});
```
- [ ] **Step 2: Run, verify it fails.** Run: `node --test test/voice-capture-server.test.js`
- [ ] **Step 3: Implement `server.js`.**
```javascript
'use strict';
const http = require('node:http');
const { validateCapture, makeStore } = require('./handler.js');
function createCaptureServer({ token, dir }) {
  const store = makeStore(dir);
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/capture') { res.writeHead(404).end(); return; }
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body; try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      const v = validateCapture(body);
      if (!v.ok) { res.writeHead(v.code).end(JSON.stringify({ error: v.error })); return; }
      try { store.put(v.value); res.writeHead(200).end('{"ok":true}'); }
      catch { res.writeHead(500).end(); }                // transient → caller retries
    });
  });
}
module.exports = { createCaptureServer };
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git add src/voice-capture/server.js test/voice-capture-server.test.js && git commit -m "feat(capture): tailnet POST /capture with auth + status mapping"`

### Task 7: Wire `/capture` into the CLI + tailnet binding doc

**Files:**
- Modify: `bin/agent-mesh.js` (add a `serve-capture <dir>` subcommand), `src/cli.js`
- Create: `docs/voice-capture-deploy.md`
- Test: `test/voice-capture-server.test.js` (add a smoke test for the CLI wiring)

- [ ] **Step 1: Write a failing smoke test** that the CLI exposes `serve-capture` and it starts a server (import the command factory, assert it returns a server).
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Add the `serve-capture` command** that reads `MAC_CAPTURE_TOKEN` + a dir arg and calls `createCaptureServer`, binding `127.0.0.1`; document exposing it via Tailscale (allowed-host + token) in `docs/voice-capture-deploy.md` (mirror the dashboard's allowed-host model; never public).
- [ ] **Step 4: Run, verify PASS.** Run `npm test` to confirm no regressions.
- [ ] **Step 5: Commit.** `git commit -am "feat(capture): serve-capture CLI + tailnet deploy doc"`

---

## Phase 3 — Outbox syncer (Python, full TDD)

### Task 8: Syncer — transient vs permanent failure policy

**Files:**
- Create: `voice-server/syncer.py`
- Test: `voice-server/test_syncer.py`

**Interfaces:** Consumes `Outbox`. Produces `sync_once(outbox, poster) -> dict` where `poster(record) -> int` returns an HTTP status (or raises for network errors). Policy: `200`→`synced`; `400/401/403`→`dead`; `429/5xx`/raise→stay pending, `attempts+=1`.

- [ ] **Step 1: Write the failing test (inject a fake poster).**
```python
import os, tempfile, unittest
from outbox import Outbox
from syncer import sync_once

class TestSyncer(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
        self.rid = self.ob.capture("/a.wav", "t"); self.ob.attach_transcript(self.rid, "hi")
    def test_200_marks_synced(self):
        sync_once(self.ob, lambda rec: 200)
        self.assertEqual(self.ob.get(self.rid)["state"], "synced")
    def test_offline_stays_pending_forever(self):
        def boom(rec): raise OSError("offline")
        for _ in range(5): sync_once(self.ob, boom)
        rec = self.ob.get(self.rid)
        self.assertIn(rec["state"], ("captured", "enriched"))   # NEVER dead on transient
        self.assertEqual(rec["attempts"], 5)
    def test_4xx_is_permanent_dead(self):
        sync_once(self.ob, lambda rec: 401)
        self.assertEqual(self.ob.get(self.rid)["state"], "dead")
```
- [ ] **Step 2: Run, verify it fails.** Run: `cd voice-server && python -m unittest test_syncer -v`
- [ ] **Step 3: Implement `syncer.py`.**
```python
def sync_once(outbox, poster):
    for rec in outbox.pending():
        rid = rec["id"]
        outbox.mark(rid, "syncing")
        try:
            status = poster(rec)
        except Exception as e:                       # network/offline → transient
            outbox.c.execute("UPDATE outbox SET attempts=attempts+1, last_error=?,"
                             " state=CASE WHEN transcript IS NULL THEN 'captured' ELSE 'enriched' END"
                             " WHERE id=?", (str(e), rid))
            continue
        if status == 200:
            outbox.mark(rid, "synced")
        elif status in (400, 401, 403):              # permanent
            outbox.mark(rid, "dead", f"http {status}")
        else:                                        # 429/5xx → transient
            outbox.c.execute("UPDATE outbox SET attempts=attempts+1, last_error=?,"
                             " state=CASE WHEN transcript IS NULL THEN 'captured' ELSE 'enriched' END"
                             " WHERE id=?", (f"http {status}", rid))
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git add voice-server/syncer.py voice-server/test_syncer.py && git commit -m "feat(voice): outbox syncer transient-vs-permanent policy"`

### Task 9: HTTP poster + idempotency key + pending-notice query

**Files:** Modify `voice-server/syncer.py`; Test `voice-server/test_syncer.py`

**Interfaces:** Produces `http_poster(url, token)` (stdlib `urllib`) sending `{id,ts,text,tags,title,source:"voice"}`; and `notices(outbox) -> {"pending": n, "dead": n}` for the next-session voice alert (spec §9).

- [ ] **Step 1: Write the failing test for `notices`.**
```python
    def test_notices_counts(self):
        d = self.ob.capture("/b.wav", "t"); self.ob.mark(d, "dead")
        from syncer import notices
        n = notices(self.ob)
        self.assertEqual(n["dead"], 1)
        self.assertGreaterEqual(n["pending"], 1)
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement `http_poster` + `notices`.**
```python
import json, urllib.request
def http_poster(url, token):
    def post(rec):
        payload = json.dumps({"id": rec["id"], "ts": rec["ts"], "text": rec["transcript"] or "",
                              "source": "voice"}).encode()
        req = urllib.request.Request(url, data=payload, method="POST",
                                     headers={"content-type": "application/json",
                                              "authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    return post
def notices(outbox):
    dead = outbox.c.execute("SELECT COUNT(*) FROM outbox WHERE state='dead'").fetchone()[0]
    pending = outbox.c.execute("SELECT COUNT(*) FROM outbox WHERE state NOT IN ('synced','dead')").fetchone()[0]
    return {"pending": pending, "dead": dead}
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(voice): http poster + next-session notice counts"`

---

## Phase 4 — Token-mint + capture-first turn loop (Python + LiveKit)

### Task 10: Token-mint — short room-scoped mic-only JWT (TDD)

**Files:**
- Create: `voice-server/token_mint.py`
- Test: `voice-server/test_token_mint.py`

**Interfaces:** Produces `mint(identity, room, ttl_s=60) -> str` (a LiveKit AccessToken JWT, `canPublish` mic-only, `room` fixed) and `single_occupant_opts() -> dict` (`maxParticipants=1`). Uses `livekit-api` (ships with `livekit-agents`).

- [ ] **Step 1: Write the failing test** (decode the JWT, assert TTL ≤ 60s, room scope, video publish disallowed).
```python
import time, unittest
from token_mint import mint
class TestMint(unittest.TestCase):
    def test_short_ttl_room_scoped_mic_only(self):
        import jwt  # PyJWT ships transitively with livekit-api; else decode payload manually
        tok = mint("phone", "drive-room", ttl_s=60)
        claims = jwt.decode(tok, options={"verify_signature": False})
        self.assertLessEqual(claims["exp"] - claims["nbf"], 65)
        self.assertEqual(claims["video"]["room"], "drive-room")
        self.assertTrue(claims["video"]["canPublish"])
        self.assertFalse(claims["video"].get("canPublishData", False) and False)  # mic-only intent
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement `token_mint.py`** using `livekit.api.AccessToken` with `VideoGrants(room_join=True, room="drive-room", can_publish=True, can_subscribe=True, can_publish_sources=["microphone"])`, `with_ttl(60)`. Add `single_occupant_opts` returning the room-create option `max_participants=1`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git add voice-server/token_mint.py voice-server/test_token_mint.py && git commit -m "feat(voice): short room-scoped mic-only token mint"`

### Task 11: Token-mint HTTP endpoint (tailnet-only, bearer)

**Files:** Create `voice-server/mint_server.py`; Test `voice-server/test_mint_server.py`

**Interfaces:** `POST /token` (bearer `TOKEN_MINT_SECRET`) → `{token, url}`; bind `127.0.0.1`; one room, `maxParticipants=1`.

- [ ] **Step 1: Write the failing test** (401 without bearer; 200 returns a JWT with the bearer).
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** with stdlib `http.server`, calling `mint(...)`. Reject second mint while a participant is active (query LiveKit room state) — or rely on `maxParticipants=1` at join (document which; the join-side cap is authoritative).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(voice): tailnet token-mint endpoint"`

### Task 12: Capture-first turn loop (LiveKit agent; integration + ordering unit test)

**Files:** Create `voice-server/agent.py`; Test `voice-server/test_agent_order.py`

**Interfaces:** Produces `handle_turn(audio_ref, ts, outbox, stt, brain, tts)` — the pure ordering core, decoupled from LiveKit, so the capture-first invariant is unit-tested.

- [ ] **Step 1: Write the failing test proving capture precedes STT/LLM and survives their failure.**
```python
import unittest, os, tempfile
from outbox import Outbox
from agent import handle_turn

class TestOrder(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
    def test_capture_happens_before_and_despite_failures(self):
        calls = []
        def stt(ref): calls.append("stt"); raise RuntimeError("stt down")
        def brain(text): calls.append("brain"); return ("reply", {})
        def tts(text): calls.append("tts")
        rid = handle_turn("/a.wav", "t", self.ob, stt, brain, tts)
        rec = self.ob.get(rid)
        self.assertIsNotNone(rec)                       # captured despite STT failure
        self.assertEqual(rec["audio_ref"], "/a.wav")    # raw audio kept for re-transcription
        self.assertEqual(calls[0], "stt")               # capture (the get above) preceded stt
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement the ordering core.**
```python
def handle_turn(audio_ref, ts, outbox, stt, brain, tts):
    rid = outbox.capture(audio_ref=audio_ref, ts=ts)    # DURABILITY COMMIT — first, unconditional
    try:
        text = stt(audio_ref)
        outbox.attach_transcript(rid, text)
    except Exception as e:
        outbox.mark(rid, "captured", f"stt: {e}")        # keep audio; re-transcribe later
        tts("Got it, I'll sort that out later.")
        return rid
    try:
        reply, enrichment = brain(text)
        if enrichment: outbox.attach_enrichment(rid, enrichment)
    except Exception as e:
        outbox.mark(rid, "enriched", f"brain: {e}")      # idea kept; minimal reply
        tts("Noted, syncing.")
        return rid
    tts(reply)                                           # truthful: brain composed a "noted, syncing"-style reply
    return rid
```
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git add voice-server/agent.py voice-server/test_agent_order.py && git commit -m "feat(voice): capture-first turn-ordering core (durability invariant)"`

### Task 13: Bind the turn core into a LiveKit Agent worker (integration)

**Files:** Modify `voice-server/agent.py` (add the LiveKit `entrypoint`)

**Interfaces:** Consumes `handle_turn`, the Spike-2 STT adapter, `token_mint`, Kokoro TTS, Gemini brain.

- [ ] **Step 1: Implement the LiveKit `entrypoint(ctx)`** that: subscribes to the mic track, runs VAD + turn detector, and on end-of-turn writes the captured audio segment to disk (`audio_ref`) then calls `handle_turn(...)` with: the faster-whisper StreamAdapter STT (Spike-2), a `brain` adapter calling Gemini function-calling (enrichment tools only), and Kokoro streaming TTS. Stream the first TTS chunk immediately.
- [ ] **Step 2: Run the agent against the dev LiveKit server** (Spike-3 setup); join from a browser; speak one idea.
- [ ] **Step 3: Verify** the outbox row reaches `enriched`, the reply streams, and the syncer (Task 8/9) POSTs to a local `/capture` (Phase 2) → row `synced`.
- [ ] **Step 4: Verify the LLM-no-tool path:** speak a vague utterance the brain doesn't enrich → row still `captured`/`enriched`, idea present.
- [ ] **Step 5: Commit.** `git commit -am "feat(voice): LiveKit agent entrypoint wired to capture-first core"`

---

## Phase 5 — Phone PWA (vanilla JS WebRTC client)

### Task 14: PWA — token fetch + WebRTC join + streaming playback

**Files:** Create `voice-server/web/index.html`, `voice-server/web/app.js`

- [ ] **Step 1: Implement** a minimal PWA: fetch a token from the mint endpoint (bearer from a stored device secret), `getUserMedia({audio:true})`, join the LiveKit room via the LiveKit JS client (`RTCPeerConnection` under the hood), publish mic, play received audio. Continuous (no per-turn tap) — server VAD drives turns.
- [ ] **Step 2: Serve `web/` over the tailnet HTTPS name** (so `getUserMedia` works — secure context). Document iOS Safari testing (installed-PWA mic caveat → test in a Safari tab first).
- [ ] **Step 3: Manual verify** on the phone: join, speak, hear a streamed reply with no tap.
- [ ] **Step 4: Commit.** `git commit -m "feat(voice): phone PWA WebRTC client (continuous, streaming playback)"`

---

## Phase 6 — Wire media plane, driving profile, acceptance

### Task 15: Wire the media plane per Spike-1's verdict

**Files:** Create `voice-server/deploy/README.md` (the chosen networking), `.wslconfig` snippet or native-SFU launch script

- [ ] **Step 1: Apply the Spike-1 decision** — mirrored networking (`.wslconfig`) OR native-Windows SFU launcher — and the firewall UDP rules; document exact ports.
- [ ] **Step 2: Implement the DERP-degrade policy** in the PWA/agent: detect relayed media (LiveKit connection stats) and surface a brief earcon/notice instead of silently shipping over TCP; prefer the Mac peer-relay off-LAN.
- [ ] **Step 3: Verify** on-LAN `direct` and off-LAN behavior match Spike-1.
- [ ] **Step 4: Commit.** `git commit -am "feat(voice): media plane wired per spike-1 + DERP-degrade"`

### Task 16: Driving profile + next-session notices

**Files:** Modify `voice-server/agent.py` (system prompt + notices on session start)

- [ ] **Step 1: Add the driving profile** (spec §11): terse ≤2-sentence replies in the brain system prompt; voice-only recovery; on session start, read `notices(outbox)` and, if `pending`/`dead` > 0, speak "N ideas still syncing / N failed to sync."
- [ ] **Step 2: Verify** Bluetooth A2DP/HFP routing + screen-lock keep audio flowing on the phone.
- [ ] **Step 3: Commit.** `git commit -am "feat(voice): driving profile + next-session sync notices"`

### Task 17: Acceptance demo (the two spec §16 scenarios)

**Files:** Create `voice-server/ACCEPTANCE.md` (run-book + recorded results)

- [ ] **Step 1: Scenario A** — drive simulation: continuous, no tap, reply ≤ ~2s, idea appears in the Mac `/capture` store. Record the per-stage latency log.
- [ ] **Step 2: Scenario B (the durability proof)** — take the Mac `/capture` offline; speak 3 ideas; verify 3 outbox rows `pending`; bring the Mac back; verify the syncer drives all 3 to `synced`; **assert nothing lost.** Also: speak one vague utterance (LLM no-tool) and confirm it's captured.
- [ ] **Step 3: Run the full Python + Node test suites** (`cd voice-server && python -m unittest discover -v` ; `npm test`) — all green.
- [ ] **Step 4: Record results in `ACCEPTANCE.md`; commit.** `git commit -m "test(voice): acceptance demo run-book + results"`

---

## Notes for the executor

- **Phase 0 gates everything.** If Spike-1 forces the native-SFU fallback or Spike-2 forces a streaming-STT swap, update Task 13/15 accordingly before building them.
- **The durability invariant (Task 12) is the heart** — capture precedes and survives STT/LLM failure. Its test is the one that must never regress.
- Python tests: `cd voice-server && python -m unittest discover -v`. Node tests: `npm test` (or `node --test test/voice-capture-*.test.js`).
- Secrets live in `voice-server/.voice-env` (chmod 600, gitignored) — never commit.
