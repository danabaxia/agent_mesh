"""End-to-end durability proof: Windows outbox + syncer  ->  Mac /capture endpoint.

Spawns the real Node /capture launcher and drives it with the real Python syncer over
HTTP, proving the cross-component contract (durable-before-2xx, idempotent sync) works.
Run: python3 e2e_roundtrip.py   (requires `node` on PATH)
"""
import os
import pathlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from outbox import Outbox          # noqa: E402
from syncer import http_poster, sync_once  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = 8799
TOKEN = "e2e-secret"


def main():
    cap_dir = tempfile.mkdtemp()
    env = {**os.environ, "CAPTURE_PORT": str(PORT), "MAC_CAPTURE_TOKEN": TOKEN, "CAPTURE_DIR": cap_dir}
    proc = subprocess.Popen(
        ["node", str(ROOT / "src/voice-capture/serve.mjs")],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(0.8)  # let the node server bind
        if proc.poll() is not None:
            print("FAIL: capture server exited:", proc.stdout.read()); sys.exit(1)

        ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
        rid = ob.capture("/seg.wav", "2026-06-27T00:00:00Z")
        ob.attach_transcript(rid, "drive idea: ship the spec")

        post = http_poster(f"http://127.0.0.1:{PORT}/capture", TOKEN)
        sync_once(ob, post)

        assert ob.get(rid)["state"] == "synced", ob.get(rid)
        stored = (pathlib.Path(cap_dir) / "captures.jsonl").read_text().strip()
        assert "ship the spec" in stored, stored

        # idempotency at the endpoint: a manual re-POST of the same id is a no-op (still 200)
        assert post(ob.get(rid)) == 200
        lines = (pathlib.Path(cap_dir) / "captures.jsonl").read_text().strip().split("\n")
        assert len(lines) == 1, lines

        print("E2E OK: outbox -> /capture roundtrip synced + durably stored, idempotent.")
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
