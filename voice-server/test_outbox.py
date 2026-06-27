import os
import tempfile
import unittest

from outbox import Outbox


class TestOutbox(unittest.TestCase):
    def setUp(self):
        self.db = os.path.join(tempfile.mkdtemp(), "o.db")
        self.ob = Outbox(self.db)

    def test_capture_returns_ulid_and_persists_captured(self):
        rid = self.ob.capture(audio_ref="/a/seg1.wav", ts="2026-06-27T00:00:00Z")
        self.assertEqual(len(rid), 26)
        rec = self.ob.get(rid)
        self.assertEqual(rec["state"], "captured")
        self.assertEqual(rec["audio_ref"], "/a/seg1.wav")
        self.assertIsNone(rec["transcript"])

    def test_enrich_and_pending_lists_unsynced(self):
        rid = self.ob.capture("/a/s.wav", "2026-06-27T00:00:00Z")
        self.ob.attach_transcript(rid, "buy milk")
        self.ob.attach_enrichment(rid, {"tags": ["errand"]})
        self.assertEqual(self.ob.get(rid)["transcript"], "buy milk")
        self.assertEqual(self.ob.get(rid)["state"], "enriched")
        self.assertIn(rid, [r["id"] for r in self.ob.pending()])
        self.ob.mark(rid, "synced")
        self.assertNotIn(rid, [r["id"] for r in self.ob.pending()])

    def test_reconcile_reverts_stuck_syncing(self):
        rid = self.ob.capture("/a/s.wav", "t")
        self.ob.mark(rid, "syncing")
        ob2 = Outbox(self.db)  # reopen (simulate restart after crash mid-sync)
        ob2.reconcile_on_start()
        self.assertEqual(ob2.get(rid)["state"], "captured")


if __name__ == "__main__":
    unittest.main()
