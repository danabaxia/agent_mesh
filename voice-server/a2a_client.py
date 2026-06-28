"""Minimal A2A SendMessage client for the voice ingress (stdlib only).

The ingress holds NO logic — it builds the v1 message, POSTs one JSON-RPC
SendMessage to the concierge's serve-a2a-http endpoint, and returns the Task.
The transport is injectable so the gate never makes a network call.
"""
import json
import urllib.request


def build_send_message(transcript, *, context_id, lang, capture_id):
    return {
        "message": {
            "parts": [{"text": transcript}],
            "contextId": context_id,
            "metadata": {
                "agentmesh/mode": "ask",
                "agentmesh/lang": lang,
                "agentmesh/captureId": capture_id,
            },
        }
    }


def parse_task(resp):
    try:
        return resp.get("result", {}).get("task", {}) or {}
    except AttributeError:
        return {}


def _urllib_transport(url, body, timeout=30):
    req = urllib.request.Request(
        url, data=body.encode(), method="POST",
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


class A2AHttpClient:
    def __init__(self, url, transport=None, timeout=30):
        self.url = url
        self.timeout = timeout
        self._transport = transport or (lambda u, b: _urllib_transport(u, b, timeout))

    def send(self, transcript, *, context_id, lang, capture_id):
        rpc = {
            "jsonrpc": "2.0", "id": capture_id, "method": "SendMessage",
            "params": build_send_message(transcript, context_id=context_id, lang=lang, capture_id=capture_id),
        }
        return parse_task(self._transport(self.url, json.dumps(rpc)))
