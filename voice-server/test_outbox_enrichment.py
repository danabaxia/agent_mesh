import json
import os
import tempfile
import unittest

from outbox import Outbox


class TestEnrichmentApply(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))

    def test_apply_enrichment_sets_state_and_payload(self):
        rid = self.ob.capture("/a.wav", "t")
        self.ob.attach_transcript(rid, "an idea")
        ok = self.ob.apply_enrichment(rid, {"idea": {"title": "Nap pods", "note": ""}})
        self.assertTrue(ok)
        rec = self.ob.get(rid)
        self.assertEqual(rec["state"], "enriched")
        self.assertIn("Nap pods", rec["enrichment"])

    def test_apply_is_idempotent_by_rid(self):
        rid = self.ob.capture("/a.wav", "t")
        self.ob.apply_enrichment(rid, {"idea": {"title": "X", "note": ""}})
        self.ob.apply_enrichment(rid, {"idea": {"title": "X", "note": ""}})
        rows = [r for r in self.ob.pending() if r["id"] == rid]
        self.assertEqual(len(rows), 1)  # one row, not duplicated

    def test_write_failure_marks_pending(self):
        rid = self.ob.capture("/a.wav", "t")

        class Boom(dict):
            pass

        # force json.dumps to fail by passing a non-serializable payload
        ok = self.ob.apply_enrichment(rid, {"idea": object()})
        self.assertFalse(ok)
        rec = self.ob.get(rid)
        self.assertEqual(rec["state"], "enrichment_pending")
        # row remains in the pending set so the next sync retries
        self.assertIn(rid, [r["id"] for r in self.ob.pending()])


if __name__ == "__main__":
    unittest.main()
