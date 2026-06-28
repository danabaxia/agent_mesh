import os
import tempfile
import unittest

from agent import handle_turn, FALLBACK
from outbox import Outbox


def completed(reply, enrichment=None):
    md = {}
    if enrichment is not None:
        md["agentmesh/enrichment"] = enrichment
    return {"status": {"state": "TASK_STATE_COMPLETED"},
            "artifacts": [{"parts": [{"text": reply}]}], "metadata": md}


class TestTurnOrder(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
        self.spoken = []

    def _tts(self, t):
        self.spoken.append(t)

    def test_capture_first_before_stt(self):
        order = []

        def stt(ref):
            order.append("stt")
            raise RuntimeError("stt down")

        def send(t, **kw):
            order.append("a2a")
            return completed("never")

        rid = handle_turn("/a.wav", "t", self.ob, stt, send, self._tts)
        rec = self.ob.get(rid)
        self.assertEqual(rec["state"], "captured")          # raw turn survived STT failure
        self.assertEqual(rec["audio_ref"], "/a.wav")
        self.assertEqual(order, ["stt"])                    # A2A never reached
        self.assertTrue(self.spoken)                        # a graceful line was spoken

    def test_empty_candidate_skips_a2a_but_stays_captured(self):
        sent = []
        rid = handle_turn("/a.wav", "t", self.ob,
                          stt=lambda ref: "   ",
                          send_a2a=lambda t, **kw: sent.append(t) or completed("x"),
                          tts=self._tts)
        rec = self.ob.get(rid)
        self.assertIsNone(rec["transcript"])                # garbled/empty not attached
        self.assertEqual(rec["state"], "captured")
        self.assertEqual(sent, [])                          # A2A skipped

    def test_happy_path_enriches_before_tts_and_speaks_reply(self):
        rid = handle_turn("/a.wav", "t", self.ob,
                          stt=lambda ref: "idea: solar awning",
                          send_a2a=lambda t, **kw: completed("Got it.", {"idea": {"title": "Solar awning", "note": ""}}),
                          tts=self._tts)
        rec = self.ob.get(rid)
        self.assertEqual(rec["transcript"], "idea: solar awning")
        self.assertEqual(rec["state"], "enriched")
        self.assertIn("Solar awning", rec["enrichment"])
        self.assertEqual(self.spoken, ["Got it."])

    def test_non_completed_task_speaks_fallback_and_leaves_row(self):
        rid = handle_turn("/a.wav", "t", self.ob,
                          stt=lambda ref: "hello",
                          send_a2a=lambda t, **kw: {"status": {"state": "TASK_STATE_FAILED"}, "artifacts": []},
                          tts=self._tts)
        rec = self.ob.get(rid)
        self.assertEqual(rec["transcript"], "hello")
        self.assertIsNone(rec["enrichment"])                # capture row unchanged
        self.assertEqual(self.spoken, [FALLBACK])

    def test_a2a_exception_speaks_fallback(self):
        def send(t, **kw):
            raise RuntimeError("unreachable")
        rid = handle_turn("/a.wav", "t", self.ob,
                          stt=lambda ref: "hello",
                          send_a2a=send, tts=self._tts)
        self.assertEqual(self.spoken, [FALLBACK])
        self.assertEqual(self.ob.get(rid)["state"], "enriched")  # transcript attached; no idea

    def test_completed_without_artifact_is_fallback(self):
        rid = handle_turn("/a.wav", "t", self.ob,
                          stt=lambda ref: "hello",
                          send_a2a=lambda t, **kw: {"status": {"state": "TASK_STATE_COMPLETED"}, "artifacts": []},
                          tts=self._tts)
        self.assertEqual(self.spoken, [FALLBACK])
        self.assertEqual(self.ob.get(rid)["transcript"], "hello")  # transcript durably kept

    def test_tts_failure_after_enrichment_keeps_idea(self):
        def boom_tts(t):
            raise RuntimeError("speaker dead")
        rid = handle_turn("/a.wav", "t", self.ob,
                          stt=lambda ref: "idea: x",
                          send_a2a=lambda t, **kw: completed("ok", {"idea": {"title": "X", "note": ""}}),
                          tts=boom_tts)
        rec = self.ob.get(rid)
        self.assertEqual(rec["state"], "enriched")          # enrichment applied BEFORE tts
        self.assertIn('"X"', rec["enrichment"])


if __name__ == "__main__":
    unittest.main()
