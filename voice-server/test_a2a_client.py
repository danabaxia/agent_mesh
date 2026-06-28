import json
import unittest

from a2a_client import build_send_message, parse_task, A2AHttpClient


class TestA2AClient(unittest.TestCase):
    def test_build_send_message_is_v1_shape(self):
        p = build_send_message("hello", context_id="c1", lang="zh", capture_id="cap1")
        msg = p["message"]
        self.assertEqual(msg["parts"], [{"text": "hello"}])
        self.assertEqual(msg["contextId"], "c1")
        self.assertEqual(msg["metadata"]["agentmesh/mode"], "ask")
        self.assertEqual(msg["metadata"]["agentmesh/lang"], "zh")
        self.assertEqual(msg["metadata"]["agentmesh/captureId"], "cap1")

    def test_parse_task_extracts_task(self):
        task = {"status": {"state": "TASK_STATE_COMPLETED"}}
        self.assertEqual(parse_task({"result": {"task": task}}), task)
        self.assertEqual(parse_task({"error": {"code": -1}}), {})
        self.assertEqual(parse_task({}), {})

    def test_client_send_round_trips_via_transport(self):
        captured = {}

        def transport(url, body):
            captured["url"] = url
            captured["body"] = json.loads(body)
            return {"result": {"task": {"status": {"state": "TASK_STATE_COMPLETED"},
                                        "artifacts": [{"parts": [{"text": "hi"}]}]}}}

        client = A2AHttpClient("http://x/rpc", transport=transport)
        task = client.send("hello", context_id="c1", lang="en", capture_id="cap9")
        self.assertEqual(task["status"]["state"], "TASK_STATE_COMPLETED")
        self.assertEqual(captured["body"]["method"], "SendMessage")
        self.assertEqual(captured["body"]["params"]["message"]["metadata"]["agentmesh/lang"], "en")


if __name__ == "__main__":
    unittest.main()
