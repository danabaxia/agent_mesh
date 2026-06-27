import os
import tempfile
import unittest

from agent import handle_turn
from outbox import Outbox


class TestTurnOrder(unittest.TestCase):
    def setUp(self):
        self.ob = Outbox(os.path.join(tempfile.mkdtemp(), "o.db"))
        self.spoken = []

    def _tts(self, t):
        self.spoken.append(t)

    def test_captured_despite_stt_failure_and_audio_kept(self):
        calls = []

        def stt(ref):
            calls.append("stt")
            raise RuntimeError("stt down")

        def brain(text):
            calls.append("brain")
            return ("reply", {})

        rid = handle_turn("/a.wav", "t", self.ob, stt, brain, self._tts)
        rec = self.ob.get(rid)
        self.assertIsNotNone(rec)  # captured despite STT failure
        self.assertEqual(rec["audio_ref"], "/a.wav")  # raw audio kept for re-transcription
        self.assertEqual(rec["state"], "captured")
        self.assertEqual(calls, ["stt"])  # brain never reached
        self.assertTrue(self.spoken)  # a graceful reply was spoken

    def test_happy_path_enriches_and_replies(self):
        rid = handle_turn(
            "/a.wav", "t", self.ob,
            stt=lambda ref: "buy milk",
            brain=lambda text: ("Noted, syncing.", {"tags": ["errand"]}),
            tts=self._tts,
        )
        rec = self.ob.get(rid)
        self.assertEqual(rec["transcript"], "buy milk")
        self.assertEqual(rec["state"], "enriched")
        self.assertIn('"errand"', rec["enrichment"])
        self.assertEqual(self.spoken, ["Noted, syncing."])

    def test_brain_failure_keeps_idea(self):
        rid = handle_turn(
            "/a.wav", "t", self.ob,
            stt=lambda ref: "an idea",
            brain=lambda text: (_ for _ in ()).throw(RuntimeError("gemini down")),
            tts=self._tts,
        )
        rec = self.ob.get(rid)
        self.assertEqual(rec["transcript"], "an idea")  # idea kept even when the brain dies
        self.assertEqual(rec["state"], "enriched")

    def test_llm_no_tool_still_captured(self):
        rid = handle_turn(
            "/a.wav", "t", self.ob,
            stt=lambda ref: "vague musing",
            brain=lambda text: ("Mm-hm.", {}),  # brain called no enrichment tool
            tts=self._tts,
        )
        rec = self.ob.get(rid)
        self.assertEqual(rec["transcript"], "vague musing")  # captured regardless of tool use
        self.assertIsNone(rec["enrichment"])


if __name__ == "__main__":
    unittest.main()
