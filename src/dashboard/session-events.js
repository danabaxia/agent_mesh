/**
 * src/dashboard/session-events.js — PURE.
 * Normalize `claude --output-format stream-json` NDJSON lines into dashboard
 * events (`parseEventLine`). Tolerant: unknown/malformed → a `raw` event,
 * never throws.
 * `parseTranscriptLine` and `redactSessionEvent` (transcript parsing + scrub/cap
 * redaction) have moved to src/session-transcripts.js (spec 2026-06-12 §5.1
 * boundary hygiene) — re-exported here for back-compat.
 */

export { parseTranscriptLine, redactSessionEvent } from '../session-transcripts.js';

/** @returns {Array<object>} normalized events (possibly several per line) */
export function parseEventLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return [{ type: 'raw', raw: String(line) }]; }
  try {
    if (msg.type === 'system' && msg.subtype === 'init') {
      return [{ type: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd }];
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      const out = [];
      for (const b of msg.message.content) {
        if (b.type === 'text') out.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        // thinking and other block types are intentionally dropped in the MVP
      }
      return out.length ? out : [{ type: 'raw', raw: line }];
    }
    if (msg.type === 'user' && msg.message?.content) {
      const out = [];
      for (const b of msg.message.content) {
        if (b.type === 'tool_result') out.push({ type: 'tool_result', toolUseId: b.tool_use_id, content: b.content });
      }
      return out.length ? out : [{ type: 'raw', raw: line }];
    }
    if (msg.type === 'result') {
      const ev = { type: 'turn_done', result: msg.result ?? '', isError: !!msg.is_error };
      // usage is a CONTROL field for the runner's headroom math (spec 2026-06-12
      // §3.2). It is not in RENDER_FIELDS['turn_done'] nor the control-field
      // carry list, so session-live's append → redactSessionEvent strips it
      // before any client sees the event.
      if (msg.usage && typeof msg.usage === 'object') ev.usage = msg.usage;
      return [ev];
    }
    return [{ type: 'raw', raw: line }];
  } catch {
    return [{ type: 'raw', raw: String(line) }];
  }
}

