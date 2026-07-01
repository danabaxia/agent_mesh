"""Pure helper for the /turn ingress: decide whether a request is a typed-text turn
or an audio turn, and normalize the stt/lang knobs. No I/O — unit-testable.

A typed message rides the SAME turn pipeline as voice, skipping only STT (the concierge
still holds all logic; this is ingress plumbing). `query` is the parsed query dict as
returned by urllib.parse.parse_qs (values are lists).
"""
MAX_TEXT = 4000


def parse_turn_request(query, default_stt="local"):
    def first(key, dflt=""):
        v = query.get(key, [dflt])
        return (v[0] if v else dflt)

    text = (first("text") or "").strip()[:MAX_TEXT]
    stt = (first("stt", default_stt) or default_stt).lower()
    lang = (first("lang") or "").lower()
    lang = lang if lang in ("zh", "en") else ""
    return {"mode": "text" if text else "audio", "text": text, "stt": stt, "lang": lang}
