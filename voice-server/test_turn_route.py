import unittest

from turn_route import build_turn_url


class TestBuildTurnUrl(unittest.TestCase):
    def test_selected_backend_and_lang(self):
        self.assertEqual(
            build_turn_url("http://127.0.0.1:8780/turn", "gemini", "en"),
            "http://127.0.0.1:8780/turn?stt=gemini&lang=en",
        )

    def test_local_backend_honoured(self):
        self.assertEqual(
            build_turn_url("http://h/turn", "local", "zh"),
            "http://h/turn?stt=local&lang=zh",
        )

    def test_existing_query_is_replaced_so_selection_wins(self):
        # A base URL that already carried ?stt=local must not double up or override
        # the UI choice — the selected backend always wins.
        self.assertEqual(
            build_turn_url("http://h/turn?stt=local", "gemini", None),
            "http://h/turn?stt=gemini",
        )

    def test_unknown_backend_defaults_to_gemini(self):
        self.assertEqual(build_turn_url("http://h/turn", "", None), "http://h/turn?stt=gemini")
        self.assertEqual(build_turn_url("http://h/turn", None, None), "http://h/turn?stt=gemini")
        self.assertEqual(build_turn_url("http://h/turn", "whisper", None), "http://h/turn?stt=gemini")

    def test_invalid_lang_dropped(self):
        self.assertEqual(build_turn_url("http://h/turn", "gemini", "fr"), "http://h/turn?stt=gemini")


if __name__ == "__main__":
    unittest.main()
