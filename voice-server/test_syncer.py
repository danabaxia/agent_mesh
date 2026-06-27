import os
import tempfile
import unittest

from outbox import Outbox
from syncer import notices, sync_once


class TestSyncer(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
        self.rid = self.ob.capture("/a.wav", "t")
        self.ob.attach_transcript(self.rid, "hi")

    def test_200_marks_synced(self):
        sync_once(self.ob, lambda rec: 200)
        self.assertEqual(self.ob.get(self.rid)["state"], "synced")

    def test_offline_stays_pending_forever(self):
        def boom(rec):
            raise OSError("offline")

        for _ in range(5):
            sync_once(self.ob, boom)
        rec = self.ob.get(self.rid)
        self.assertIn(rec["state"], ("captured", "enriched"))  # NEVER dead on transient
        self.assertEqual(rec["attempts"], 5)

    def test_5xx_stays_pending(self):
        sync_once(self.ob, lambda rec: 503)
        self.assertIn(self.ob.get(self.rid)["state"], ("captured", "enriched"))
        self.assertEqual(self.ob.get(self.rid)["attempts"], 1)

    def test_4xx_is_permanent_dead(self):
        sync_once(self.ob, lambda rec: 401)
        self.assertEqual(self.ob.get(self.rid)["state"], "dead")

    def test_notices_counts(self):
        d = self.ob.capture("/b.wav", "t")
        self.ob.mark(d, "dead")
        n = notices(self.ob)
        self.assertEqual(n["dead"], 1)
        self.assertGreaterEqual(n["pending"], 1)


if __name__ == "__main__":
    unittest.main()
