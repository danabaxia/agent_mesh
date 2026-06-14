// src/digest-extract.js — reduce a session transcript to a bounded, redacted,
// text-only extract for the digest worker (spec 2026-06-12 §5.1). The READ is
// bounded (last 4× the output budget), not just the output: a digest must
// never pay an unbounded parse of the very transcript that overflowed.
import { open } from 'node:fs/promises';
import { parseTranscriptLine, redactSessionEvent } from './session-transcripts.js';
import { DEFAULT_DIGEST_EXTRACT_MAX_CHARS } from './config.js';

const READ_FACTOR = 4;

export async function extractForDigest(transcriptPath, { maxChars = DEFAULT_DIGEST_EXTRACT_MAX_CHARS } = {}) {
  let text;
  const fh = await open(transcriptPath, 'r');
  try {
    const s = await fh.stat();
    const cap = Math.min(s.size, READ_FACTOR * maxChars);
    if (cap === 0) return '';
    const offset = s.size - cap;
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, offset);
    text = buf.toString('utf8');
    if (offset > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
  } finally { await fh.close(); }

  // Conversation text only — tool_use/tool_result dropped, mirroring what
  // auto-compaction deprioritizes; every kept string goes through redaction.
  const sections = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    for (const raw of parseTranscriptLine(line)) {
      if (raw.type !== 'user_text' && raw.type !== 'text') continue;
      const ev = redactSessionEvent(raw);
      sections.push(`${raw.type === 'user_text' ? 'USER' : 'ASSISTANT'}: ${ev.text}`);
    }
  }
  // Newest-first budget, chronological output.
  const kept = [];
  let total = 0;
  for (let i = sections.length - 1; i >= 0; i--) {
    const len = sections[i].length + 2;
    // A single section larger than the whole budget breaks immediately → ''
    // extract; the digest caller treats that as an empty_extract error.
    if (total + len > maxChars) break;
    kept.push(sections[i]);
    total += len;
  }
  return kept.reverse().join('\n\n');
}
