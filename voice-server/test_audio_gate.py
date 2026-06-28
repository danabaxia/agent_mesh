import unittest

from audio_gate import has_speech


class TestSpeechGate(unittest.TestCase):
    SR = 16000

    def test_too_short_is_rejected(self):
        # 0.1s of loud audio — too short to be a real utterance
        loud_short = [12000 if i % 2 else -12000 for i in range(int(0.1 * self.SR))]
        self.assertFalse(has_speech(loud_short, self.SR))

    def test_pure_silence_is_rejected(self):
        self.assertFalse(has_speech([0] * self.SR, self.SR))

    def test_quiet_hiss_below_floor_is_rejected(self):
        # ~0.0015 RMS, well below the 0.012 floor — the near-silent clips that hallucinate
        hiss = [50 if i % 2 else -50 for i in range(self.SR)]
        self.assertFalse(has_speech(hiss, self.SR))

    def test_loud_voiced_clip_is_accepted(self):
        # 1s, high energy, every frame voiced
        speech = [12000 if i % 2 else -12000 for i in range(self.SR)]
        self.assertTrue(has_speech(speech, self.SR))

    def test_mostly_silent_with_tiny_blip_is_rejected(self):
        # 1s mostly silent with a 50ms loud blip → voiced fraction below min → rejected
        clip = [0] * self.SR
        for i in range(int(0.05 * self.SR)):
            clip[i] = 12000 if i % 2 else -12000
        self.assertFalse(has_speech(clip, self.SR))


if __name__ == "__main__":
    unittest.main()
