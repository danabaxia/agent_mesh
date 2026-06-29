"""STT vocabulary bias for the voice ingress.

Builds whisper's `initial_prompt` from a fixed domain vocabulary plus the mesh
agent roster, so the recogniser is primed toward high-relevance words and stops
guessing unrelated homophones (e.g. "coder" -> "road" / "Corder").

This is pure string building — a transcription PRIOR (data quality), NOT logic:
no models, no tool loop, no mesh query (P1: voice = data ingress only). The agent
names default to the known roster and can be EXTENDED at runtime via the
`STT_BIAS_WORDS` env (comma-separated) — e.g. the supervisor can inject the live
registry's agent names so this never drifts, without any code change.
"""
import os

# High-frequency mesh vocabulary + the current agent roster. Multi-word terms are
# allowed here (they go in verbatim); env-supplied extras are comma-separated.
_DOMAIN_WORDS = [
    "agent mesh", "mesh", "agent", "peer", "delegate", "A2A",
    "coder", "tester", "analyst", "concierge",
    "issue", "PR", "pull request", "repo", "registry", "idea",
]

# Language-specific lead-in; the term list (mostly English technical words) is
# appended to both so whisper biases toward them in either language.
_BASE = {
    "zh": "这是关于 agent mesh 的普通话对话，常出现这些英文术语：",
    "en": "A spoken conversation about an agent mesh. Likely terms:",
}


def bias_words():
    """The domain roster, extended (never replaced) by `STT_BIAS_WORDS`.

    Dedupes case-insensitively while preserving order, so injecting live agent
    names that already exist in the roster doesn't double them.
    """
    extra = os.environ.get("STT_BIAS_WORDS", "")
    extras = [w.strip() for w in extra.split(",") if w.strip()]
    seen, out = set(), []
    for w in _DOMAIN_WORDS + extras:
        key = w.lower()
        if key not in seen:
            seen.add(key)
            out.append(w)
    return out


def stt_prompt(lang):
    """whisper initial_prompt for `lang` ("zh"/"en"), biased toward the roster."""
    base = _BASE.get(lang or "zh", _BASE["zh"])
    return base + " " + ", ".join(bias_words()) + "."
