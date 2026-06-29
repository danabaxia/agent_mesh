"""Pure helper for the LiveKit bridge: build the per-turn serve_turn URL from the
base URL, the UI-selected STT backend, and the locked language.

No I/O, no livekit import — unit-testable on its own. Keeping it pure is what lets
us test the STT-backend routing (the bit the UI selector drives) without a GPU or
a LiveKit room. An unknown/empty backend falls back to "gemini" (the UI default);
any query already on the base URL is dropped so the selected backend always wins.
"""
VALID_STT = ("gemini", "local")
DEFAULT_STT = "gemini"


def build_turn_url(turn_url, stt_backend, lang=None):
    base = (turn_url or "").split("?", 1)[0]
    stt = stt_backend if stt_backend in VALID_STT else DEFAULT_STT
    query = f"?stt={stt}"
    if lang in ("zh", "en"):
        query += f"&lang={lang}"
    return base + query
