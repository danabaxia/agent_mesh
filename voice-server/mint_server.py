"""Tailnet-only token-mint endpoint: POST /token (bearer TOKEN_MINT_SECRET) -> {token,url,room}.

The phone PWA calls this with its device secret to get a short room-scoped mic-only JWT,
then joins the LiveKit room. Bind 127.0.0.1 (expose via Tailscale). One room, single
occupant — the join-side maxParticipants=1 is the authoritative cap (a second join is
rejected by LiveKit), so this endpoint just mints.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from token_mint import ROOM, mint


def _make_handler(secret, lk_url):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            if self.path != "/token":
                self.send_response(404); self.end_headers(); return
            if self.headers.get("authorization", "") != f"Bearer {secret}":
                self.send_response(401); self.end_headers(); return
            length = int(self.headers.get("content-length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw) if raw else {}
            except Exception:
                body = {}
            identity = str(body.get("identity", "phone"))[:64]
            tok = mint(identity, ROOM, ttl_s=60)
            payload = json.dumps({"token": tok, "url": lk_url, "room": ROOM}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return H


def create_mint_server(secret, lk_url="ws://127.0.0.1:7880", host="127.0.0.1", port=8788):
    return HTTPServer((host, port), _make_handler(secret, lk_url))


def main(env=None):
    env = env or os.environ
    secret = env.get("TOKEN_MINT_SECRET", "")
    if not secret:
        print("TOKEN_MINT_SECRET is required"); return 2
    lk_url = env.get("LIVEKIT_WS_URL", "ws://127.0.0.1:7880")
    port = int(env.get("MINT_PORT", "8788"))
    srv = create_mint_server(secret, lk_url=lk_url, port=port)
    print(f"token-mint listening 127.0.0.1:{port} -> {lk_url} room={ROOM}", flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
