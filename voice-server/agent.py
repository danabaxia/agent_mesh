"""Capture-first turn-ordering core (pure; decoupled from LiveKit).

THE DURABILITY INVARIANT (spec §5): the raw turn is committed to the outbox FIRST,
before STT or the brain run. STT and the brain only ENRICH a captured record — they
can never decide whether the idea is kept. An idea survives STT failure (audio kept
for re-transcription) and brain failure / no-tool (transcript kept).

  stt(audio_ref) -> text                 (may raise)
  brain(text)    -> (reply, enrichment)   (may raise; enrichment may be {})
  tts(text)      -> None                  (speak; truthful "noted, syncing" phrasing)
"""


def handle_turn(audio_ref, ts, outbox, stt, brain, tts):
    rid = outbox.capture(audio_ref=audio_ref, ts=ts)  # DURABILITY COMMIT — first, unconditional
    try:
        text = stt(audio_ref)
        outbox.attach_transcript(rid, text)
    except Exception as e:
        outbox.mark(rid, "captured", f"stt: {e}")  # keep audio; re-transcribe later
        tts("Got it, I'll sort that out later.")
        return rid
    try:
        reply, enrichment = brain(text)
        if enrichment:
            outbox.attach_enrichment(rid, enrichment)
    except Exception as e:
        outbox.mark(rid, "enriched", f"brain: {e}")  # idea kept; minimal reply
        tts("Noted, syncing.")
        return rid
    tts(reply)
    return rid
