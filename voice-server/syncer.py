"""Outbox syncer: push captured ideas to the Mac /capture sink.

Failure policy (spec §9):
  200            -> synced
  400/401/403    -> dead  (PERMANENT: schema/auth — a misconfiguration, not normal runtime)
  429/5xx/raise  -> stay pending, attempts+1  (TRANSIENT: offline/throttle — retried forever)
Idempotent on the record id (ULID), so at-least-once delivery => exactly-once storage.
"""
import json
import urllib.error
import urllib.request


def _revert_pending(outbox, rid, err):
    outbox.c.execute(
        "UPDATE outbox SET attempts=attempts+1, last_error=?,"
        " state=CASE WHEN transcript IS NULL THEN 'captured' ELSE 'enriched' END WHERE id=?",
        (err, rid),
    )


def sync_once(outbox, poster):
    """Drain pending records once. `poster(record) -> int` (HTTP status) or raises on network error."""
    for rec in outbox.pending():
        rid = rec["id"]
        outbox.mark(rid, "syncing")
        try:
            status = poster(rec)
        except Exception as e:  # offline / network -> transient
            _revert_pending(outbox, rid, str(e))
            continue
        if status == 200:
            outbox.mark(rid, "synced")
        elif status in (400, 401, 403):
            outbox.mark(rid, "dead", f"http {status}")
        else:  # 429 / 5xx -> transient
            _revert_pending(outbox, rid, f"http {status}")


def http_poster(url, token):
    """stdlib POST /capture with the bearer token; returns the HTTP status."""
    def post(rec):
        payload = json.dumps(
            {"id": rec["id"], "ts": rec["ts"], "text": rec["transcript"] or "", "source": "voice"}
        ).encode()
        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code  # 4xx/5xx: let sync_once classify dead vs transient

    return post


def notices(outbox):
    """Counts for the next-session voice alert (spec §9): 'N still syncing / N failed'."""
    dead = outbox.c.execute("SELECT COUNT(*) FROM outbox WHERE state='dead'").fetchone()[0]
    pending = outbox.c.execute(
        "SELECT COUNT(*) FROM outbox WHERE state NOT IN ('synced','dead')"
    ).fetchone()[0]
    return {"pending": pending, "dead": dead}
