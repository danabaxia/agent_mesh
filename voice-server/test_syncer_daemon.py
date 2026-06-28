"""TDD for the syncer daemon loop: reconcile-on-start + bounded cycles draining the outbox."""
import os
import tempfile
import unittest

from outbox import Outbox
from syncer_daemon import run_syncer


class TestSyncerDaemon(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
        self.rid = self.ob.capture("/a.wav", "t")
        self.ob.attach_transcript(self.rid, "buy milk")

    def test_runs_bounded_cycles_and_syncs(self):
        n = run_syncer(self.ob, lambda rec: 200, max_cycles=1, sleep=lambda s: None)
        self.assertEqual(n, 1)
        self.assertEqual(self.ob.get(self.rid)["state"], "synced")

    def test_reconciles_stuck_syncing_then_syncs(self):
        self.ob.mark(self.rid, "syncing")  # simulate crash mid-sync
        run_syncer(self.ob, lambda rec: 200, max_cycles=1, sleep=lambda s: None)
        self.assertEqual(self.ob.get(self.rid)["state"], "synced")

    def test_zero_cycles_only_reconciles(self):
        self.ob.mark(self.rid, "syncing")
        run_syncer(self.ob, lambda rec: 200, max_cycles=0, sleep=lambda s: None)
        self.assertEqual(self.ob.get(self.rid)["state"], "enriched")  # reverted, not synced

    def test_offline_keeps_pending_never_dead(self):
        def boom(rec):
            raise OSError("offline")
        run_syncer(self.ob, boom, max_cycles=3, sleep=lambda s: None)
        rec = self.ob.get(self.rid)
        self.assertIn(rec["state"], ("captured", "enriched"))
        self.assertEqual(rec["attempts"], 3)


if __name__ == "__main__":
    unittest.main()
