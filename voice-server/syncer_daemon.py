"""Syncer daemon: reconcile crashed `syncing` rows, then drain the outbox to the
Mac /capture sink on an interval — forever (transient failures stay pending and retry).

Run on the voice box:
    MAC_CAPTURE_URL=http://127.0.0.1:8787/capture \\
    MAC_CAPTURE_TOKEN=... VOICE_DB=/opt/voice/turns.db \\
    python3 syncer_daemon.py

The URL is typically a localhost port reverse-tunneled (ssh -R) to the Mac, so
nothing is exposed beyond loopback. Idempotent on the record id => exactly-once.
"""
import os
import sys
import time

from outbox import Outbox
from syncer import http_poster, notices, sync_once


def run_syncer(outbox, poster, *, max_cycles=None, interval_s=5.0, sleep=time.sleep, reconcile=True):
    """Reconcile once, then run sync_once for up to max_cycles (None = forever).
    Returns the number of sync cycles run. `sleep`/`poster` are injectable for tests."""
    if reconcile:
        outbox.reconcile_on_start()
    cycles = 0
    while max_cycles is None or cycles < max_cycles:
        sync_once(outbox, poster)
        cycles += 1
        if max_cycles is None or cycles < max_cycles:
            sleep(interval_s)
    return cycles


def main(env=None):
    env = env or os.environ
    db = env.get("VOICE_DB", "/opt/voice/turns.db")
    url = env.get("MAC_CAPTURE_URL", "http://127.0.0.1:8787/capture")
    token = env.get("MAC_CAPTURE_TOKEN", "")
    interval = float(env.get("SYNC_INTERVAL_S", "5"))
    if not token:
        print("MAC_CAPTURE_TOKEN is required", file=sys.stderr)
        return 2
    ob = Outbox(db)
    n = notices(ob)
    print(f"syncer up: db={db} -> {url} (pending={n['pending']} dead={n['dead']})", flush=True)
    run_syncer(ob, http_poster(url, token), interval_s=interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
