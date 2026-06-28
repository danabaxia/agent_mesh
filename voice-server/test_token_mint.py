"""TDD for the LiveKit token mint: short TTL, room-scoped, microphone-only, single-occupant.
Runs where the voice stack (livekit-api + PyJWT) is installed — i.e. the voice box."""
import unittest

import jwt  # PyJWT ships with livekit-api
from token_mint import mint, single_occupant_opts


class TestMint(unittest.TestCase):
    def test_short_ttl_room_scoped_mic_only(self):
        tok = mint("phone", "drive-room", ttl_s=60, api_key="devkey", api_secret="secret")
        claims = jwt.decode(tok, "secret", algorithms=["HS256"])  # verifies signature too
        self.assertLessEqual(claims["exp"] - claims["nbf"], 65)
        self.assertEqual(claims["sub"], "phone")
        v = claims["video"]
        self.assertEqual(v["room"], "drive-room")
        self.assertTrue(v["roomJoin"])
        self.assertTrue(v["canPublish"])
        self.assertIn("microphone", v["canPublishSources"])

    def test_single_occupant_opts(self):
        self.assertEqual(single_occupant_opts()["max_participants"], 1)


if __name__ == "__main__":
    unittest.main()
