import os
import unittest

import stt_bias


class TestSttBias(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("STT_BIAS_WORDS", None)

    def test_prompt_includes_agent_roster_in_both_langs(self):
        # The whole point: the recogniser must be primed with the real agent
        # names so it stops mis-hearing "coder" as "road"/"Corder".
        for lang in ("zh", "en"):
            p = stt_bias.stt_prompt(lang)
            for name in ("coder", "tester", "analyst"):
                self.assertIn(name, p, f"{name!r} missing from {lang} STT prompt")
            self.assertIn("agent mesh", p)

    def test_env_extends_roster_without_dropping_base(self):
        os.environ["STT_BIAS_WORDS"] = "docsmith, reviewer"
        p = stt_bias.stt_prompt("en")
        self.assertIn("docsmith", p)      # injected (e.g. from the live registry)
        self.assertIn("reviewer", p)
        self.assertIn("coder", p)         # base roster still present

    def test_dedupes_case_insensitively(self):
        os.environ["STT_BIAS_WORDS"] = "Coder, CODER"
        p = stt_bias.stt_prompt("en")
        self.assertEqual(p.lower().count("coder"), 1)

    def test_lang_lead_in_differs(self):
        self.assertNotEqual(stt_bias.stt_prompt("zh"), stt_bias.stt_prompt("en"))

    def test_unknown_lang_falls_back_to_zh_base(self):
        self.assertEqual(stt_bias.stt_prompt("fr"), stt_bias.stt_prompt("zh"))


if __name__ == "__main__":
    unittest.main()
