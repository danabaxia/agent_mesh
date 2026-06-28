import os
import unittest


class TestIngressNoLogic(unittest.TestCase):
    def test_serve_turn_has_no_brain_logic(self):
        with open(os.path.join(os.path.dirname(__file__), "serve_turn.py")) as f:
            src = f.read()
        for forbidden in ["def brain_turn", "def brain_stream", "FunctionDeclaration",
                          "_exec_tool", "record_idea", "ask_mesh_agent", "SYS ="]:
            self.assertNotIn(forbidden, src, f"voice ingress must not contain `{forbidden}` (logic belongs in the concierge agent)")

    def test_serve_turn_sends_exactly_one_a2a_call_per_turn(self):
        with open(os.path.join(os.path.dirname(__file__), "serve_turn.py")) as f:
            src = f.read()
        self.assertIn("handle_turn", src)             # routes through the brain-free core
        self.assertIn("A2AHttpClient", src)           # talks to the agent over A2A


if __name__ == "__main__":
    unittest.main()
