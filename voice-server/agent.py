"""Capture-first, logic-free turn core (pure; decoupled from LiveKit and the model).

THE VOICE SERVICE CARRIES NO LOGIC (CLAUDE.md P1). This core only moves data:
  1. capture the raw turn to the outbox FIRST (before STT or A2A) — durability,
  2. STT -> a candidate transcript; attach only a VALID candidate,
  3. one A2A SendMessage to the concierge agent (the reasoning lives there),
  4. on a COMPLETED Task with a reply artifact: apply enrichment to the captured
     row BEFORE TTS (so a TTS failure never strands an idea), then speak the reply;
     any other Task outcome -> speak the fixed fallback, leave the captured row.

Injected callables (no model/transport imported here):
  stt(audio_ref) -> str                                  (may raise)
  send_a2a(transcript, *, context_id, lang, capture_id) -> task dict   (may raise)
  tts(text) -> None
  validate(text) -> bool
"""

FALLBACK = "抱歉，连不上助手，稍后再试"


def default_validate(text) -> bool:
    return bool(text and text.strip())


def task_completed(task) -> bool:
    return (task or {}).get("status", {}).get("state") == "TASK_STATE_COMPLETED"


def task_reply(task):
    for art in (task or {}).get("artifacts", []) or []:
        for part in art.get("parts", []) or []:
            if isinstance(part.get("text"), str) and part["text"]:
                return part["text"]
    return None


def task_enrichment(task):
    md = (task or {}).get("metadata", {}) or {}
    enr = md.get("agentmesh/enrichment")
    return enr if isinstance(enr, dict) else None


def handle_turn(audio_ref, ts, outbox, stt, send_a2a, tts, *,
                context_id=None, lang="zh", validate=None, fallback=FALLBACK):
    validate = validate or default_validate
    rid = outbox.capture(audio_ref=audio_ref, ts=ts)  # DURABILITY COMMIT — first, unconditional

    # 2. STT -> candidate; attach only a valid candidate.
    try:
        candidate = stt(audio_ref)
    except Exception as e:  # noqa: BLE001
        outbox.mark(rid, "captured", f"stt: {e}")  # keep audio; re-transcribe later
        _say(tts, "Got it, I'll sort that out later.")
        return rid
    if not validate(candidate):
        outbox.mark(rid, "captured", "stt: empty/garbled candidate")  # stay captured, skip A2A
        return rid
    outbox.attach_transcript(rid, candidate)

    # 3. One A2A SendMessage — the ONLY outbound call. No tool loop, no mesh query here.
    try:
        task = send_a2a(candidate, context_id=context_id, lang=lang, capture_id=rid)
    except Exception as e:  # noqa: BLE001
        # "enriched" = transcript-attached (the outbox's existing state convention, set by
        # attach_transcript above) — NOT "has idea". No enrichment payload is applied here;
        # we only record why A2A failed. The captured turn stays durable + re-syncable.
        outbox.mark(rid, "enriched", f"a2a: {e}")
        _say(tts, fallback)
        return rid

    # 4. Task-state gating: only COMPLETED + reply artifact is usable.
    reply = task_reply(task)
    if not (task_completed(task) and reply):
        _say(tts, fallback)  # capture row unchanged
        return rid

    enr = task_enrichment(task)
    if enr:
        outbox.apply_enrichment(rid, enr)  # BEFORE tts — idea durable regardless of playback
    _say(tts, reply)
    return rid


def _say(tts, text):
    try:
        tts(text)
    except Exception:  # noqa: BLE001 — playback failure never crashes the turn
        pass
