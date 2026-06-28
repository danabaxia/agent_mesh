"""TDD for the token-mint endpoint: 401 without bearer, 200 returns a usable JWT."""
import json
import threading
import unittest
import urllib.error
import urllib.request

import jwt
from mint_server import create_mint_server


class TestMintServer(unittest.TestCase):
    def setUp(self):
        self.srv = create_mint_server("topsecret", lk_url="ws://127.0.0.1:7880", port=0)
        self.port = self.srv.server_address[1]
        self.t = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.t.start()

    def tearDown(self):
        self.srv.shutdown()

    def _post(self, token=None, body=b"{}"):
        headers = {"authorization": f"Bearer {token}"} if token else {}
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/token", data=body, method="POST", headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_401_without_bearer(self):
        status, _ = self._post()
        self.assertEqual(status, 401)

    def test_200_returns_room_scoped_jwt(self):
        status, body = self._post("topsecret", body=b'{"identity":"phone-1"}')
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertEqual(d["url"], "ws://127.0.0.1:7880")
        self.assertEqual(d["room"], "drive-room")
        claims = jwt.decode(d["token"], "secret", algorithms=["HS256"])  # dev secret
        self.assertEqual(claims["sub"], "phone-1")
        self.assertEqual(claims["video"]["room"], "drive-room")


if __name__ == "__main__":
    unittest.main()
