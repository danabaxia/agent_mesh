import unittest

from turn_input import parse_turn_request, MAX_TEXT


class TestParseTurnRequest(unittest.TestCase):
    def test_text_present_is_text_mode(self):
        r = parse_turn_request({"text": ["hello concierge"], "lang": ["en"]})
        self.assertEqual(r["mode"], "text")
        self.assertEqual(r["text"], "hello concierge")
        self.assertEqual(r["lang"], "en")

    def test_no_text_is_audio_mode(self):
        r = parse_turn_request({"stt": ["gemini"]})
        self.assertEqual(r["mode"], "audio")
        self.assertEqual(r["text"], "")
        self.assertEqual(r["stt"], "gemini")

    def test_whitespace_only_text_is_audio(self):
        self.assertEqual(parse_turn_request({"text": ["   "]})["mode"], "audio")

    def test_stt_and_lang_defaults_and_normalization(self):
        r = parse_turn_request({}, default_stt="local")
        self.assertEqual(r["stt"], "local")
        self.assertEqual(r["lang"], "")           # unset → no lock
        r2 = parse_turn_request({"lang": ["fr"]})
        self.assertEqual(r2["lang"], "")           # unsupported → dropped

    def test_oversize_text_is_truncated(self):
        r = parse_turn_request({"text": ["x" * (MAX_TEXT + 500)]})
        self.assertEqual(len(r["text"]), MAX_TEXT)
        self.assertEqual(r["mode"], "text")


if __name__ == "__main__":
    unittest.main()
