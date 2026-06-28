"""Combined origin for the phone: serve the PWA static files + POST /token (mint).
One HTTPS origin (via `tailscale serve`) keeps the PWA, token, and LiveKit wss
same-site. Env: PWA_SECRET (device bearer), PWA_PORT (9000), LIVEKIT_WSS, WEB_DIR."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from token_mint import ROOM, mint

SECRET = os.environ.get("PWA_SECRET", "")
WSS = os.environ.get("LIVEKIT_WSS", "wss://enoch.taila74546.ts.net:7443")
WEB = os.environ.get("WEB_DIR", "/opt/voice/web")
CTYPE = {".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] != "/token":
            self._send(404, b'{"error":"not found"}'); return
        if self.headers.get("authorization", "") != f"Bearer {SECRET}":
            self._send(401, b'{"error":"unauthorized"}'); return
        length = int(self.headers.get("content-length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {}
        identity = str(body.get("identity", "phone"))[:64]
        tok = mint(identity, ROOM, ttl_s=120)
        self._send(200, json.dumps({"token": tok, "url": WSS, "room": ROOM}).encode())

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/":
            p = "/index.html"
        fp = os.path.normpath(os.path.join(WEB, p.lstrip("/")))
        if not fp.startswith(os.path.realpath(WEB)) or not os.path.isfile(fp):
            self._send(404, b"not found", "text/plain"); return
        ext = os.path.splitext(fp)[1]
        self._send(200, open(fp, "rb").read(), CTYPE.get(ext, "text/plain"))


def main():
    if not SECRET:
        print("PWA_SECRET is required"); return 2
    port = int(os.environ.get("PWA_PORT", "9000"))
    print(f"pwa+token on 0.0.0.0:{port} (web={WEB}, wss={WSS})", flush=True)
    HTTPServer(("0.0.0.0", port), H).serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
