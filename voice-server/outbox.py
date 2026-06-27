"""Durable capture outbox (SQLite WAL) — the 'never lose an idea' substrate.

States: captured -> enriched -> syncing -> {synced | dead}
Capture is the durability commit; STT/LLM only enrich a captured record.
"""
import json
import secrets
import sqlite3
import time

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid() -> str:
    """26-char Crockford base32 ULID (time-prefixed; single-writer monotonic-enough)."""
    ms = int(time.time() * 1000)
    n = (ms << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[n & 31])
        n >>= 5
    return "".join(reversed(out))


_DDL = """
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, audio_ref TEXT,
  transcript TEXT, enrichment TEXT,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
"""

_KEYS = ["id", "ts", "audio_ref", "transcript", "enrichment", "state", "attempts", "last_error"]
_COLS = ",".join(_KEYS)


class Outbox:
    def __init__(self, db_path: str):
        # autocommit; WAL + synchronous=FULL => each write is durable before we return.
        self.c = sqlite3.connect(db_path, isolation_level=None)
        self.c.execute("PRAGMA journal_mode=WAL")
        self.c.execute("PRAGMA synchronous=FULL")
        self.c.execute(_DDL)

    def capture(self, audio_ref: str, ts: str) -> str:
        """Durability commit. Returns the record id."""
        rid = _ulid()
        self.c.execute(
            "INSERT INTO outbox(id,ts,audio_ref,state) VALUES(?,?,?, 'captured')",
            (rid, ts, audio_ref),
        )
        return rid

    def attach_transcript(self, rid: str, text: str):
        self.c.execute(
            "UPDATE outbox SET transcript=?,"
            " state=CASE WHEN state='captured' THEN 'enriched' ELSE state END WHERE id=?",
            (text, rid),
        )

    def attach_enrichment(self, rid: str, d: dict):
        self.c.execute("UPDATE outbox SET enrichment=? WHERE id=?", (json.dumps(d), rid))

    def mark(self, rid: str, state: str, err: str = None):
        self.c.execute("UPDATE outbox SET state=?, last_error=? WHERE id=?", (state, err, rid))

    def get(self, rid: str):
        row = self.c.execute(f"SELECT {_COLS} FROM outbox WHERE id=?", (rid,)).fetchone()
        return dict(zip(_KEYS, row)) if row else None

    def pending(self):
        rows = self.c.execute(
            f"SELECT {_COLS} FROM outbox WHERE state NOT IN ('synced','dead') ORDER BY id"
        ).fetchall()
        return [dict(zip(_KEYS, r)) for r in rows]

    def reconcile_on_start(self):
        """Crash mid-sync leaves 'syncing'; revert so the syncer retries (Mac side is idempotent)."""
        self.c.execute(
            "UPDATE outbox SET state=CASE WHEN transcript IS NULL THEN 'captured' ELSE 'enriched' END"
            " WHERE state='syncing'"
        )
