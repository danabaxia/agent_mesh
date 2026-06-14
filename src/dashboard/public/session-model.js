// session-model.js — PURE turn-grouping model for claude-session JSONL records.
//
// Ported faithfully from the approved reference generator
// (tmp_browser_test/gen_real_demo.py) per the LOCKED turn-boundary rules in
// docs/superpowers/plans/2026-06-11-dashboard-redesign-phase7-turn-canvas.md:
//   - GENUINE prompt = type:'user' record whose message.content is a string or
//     contains {type:'text'} items, excluding NOISE-prefixed texts.
//     (tool_result-only user records are tool echoes, not prompts.)
//   - Turn = genuine prompt + everything until the next genuine prompt (or EOF).
//   - ANSWER = the trailing run of consecutive assistant/text blocks in the
//     turn, joined by blank lines. Intermediate texts/tool calls are internals.
//   - Sub-agent/sidechain records (rec.isSidechain === true) are skipped
//     entirely (out of scope for Phase-7 grouping).
//
// No DOM, no fetch — unit-testable in node.

const NOISE = [
  '<local-command-caveat',
  'Caveat:',
  '[Request interrupted',
  '<command-name>',
  '<system-reminder>'
];

const TITLE_MAX = 70;
const TOOL_INPUT_PREVIEW = 90;

/** Artifact type heuristic (Phase-3 contract: report|table|chart|diff). */
export function sniffType(raw) {
  const s = String(raw ?? '').trim();
  if (looksLikeTable(s)) return 'table';
  if (/^--- a\//m.test(s) || /^\+\+\+ b?\//m.test(s) || /^@@ [-+0-9, ]+@@/m.test(s)) return 'diff';
  if (s.startsWith('<svg')) return 'chart';
  return 'report';
}

// ── image references in an answer (canvas image rendering, Phase 7 fix) ─────
// Agents reference produced images three ways: markdown ![alt](path), a
// backticked `filename.png`, or a bare/absolute path in prose. Extract all,
// dedupe by basename, and pre-map anything under a deliverables/ segment to
// its deliverables-relative path (the dashboard can only serve those — the
// caller resolves bare filenames against the deliverables listing).
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

export function extractImageRefs(text) {
  const s = String(text ?? '');
  const found = [];
  const seen = new Set();
  const push = (raw) => {
    const clean = raw.trim().replace(/^[`"'(<]+|[`"')>.,;:]+$/g, '');
    if (!IMG_EXT.test(clean)) return;
    const basename = clean.split(/[\\/]/).pop();
    if (seen.has(basename)) return;
    seen.add(basename);
    // map any path containing a deliverables/ segment → relative-to-deliverables
    const m = clean.replace(/\\/g, '/').match(/(?:^|\/)deliverables\/(.+)$/);
    found.push({ path: clean, basename, deliverablesRel: m ? m[1] : null });
  };
  // markdown images first (their parens would confuse the token scan)
  for (const m of s.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) push(m[1]);
  // backticked tokens, then bare path-ish tokens
  for (const m of s.matchAll(/`([^`\n]+)`/g)) push(m[1]);
  for (const m of s.matchAll(/(?:[A-Za-z]:)?[\w./\\-]+\.(?:png|jpe?g|gif|svg|webp)/gi)) push(m[0]);
  return found;
}

function looksLikeTable(s) {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && /^\|?[\s:|-]*-{2,}[\s:|-]*\|[\s:|-]*$/.test(lines[i + 1])) return true;
  }
  const commas = lines.slice(0, 10).map((l) => (l.match(/,/g) || []).length);
  return commas.length >= 2 && commas[0] >= 1 && commas.every((c) => c === commas[0]);
}

/**
 * Genuine prompt text of a record, or '' when the record is not a genuine
 * user prompt (assistant/tool-echo/noise/sidechain). Multiple text items in
 * one record are joined with blank lines.
 */
export function genuinePromptText(rec) {
  if (!rec || rec.type !== 'user' || rec.isSidechain === true) return '';
  return userTexts(rec).join('\n\n');
}

function userTexts(rec) {
  const content = (rec.message || {}).content;
  let texts = [];
  if (typeof content === 'string') texts = [content];
  else if (Array.isArray(content)) {
    texts = content.filter((c) => c && c.type === 'text').map((c) => c.text ?? '');
  }
  return texts
    .map((x) => String(x).trim())
    .filter((x) => x && !NOISE.some((n) => x.startsWith(n)));
}

/**
 * Group raw transcript records into Q→A turns.
 * @param {Array<object>} records — claude-session JSONL objects, in order.
 * @returns {Array<{q:string, qts:string, ats:string, answer:string,
 *   tools:number, title:string, type:string,
 *   internals:Array<{kind:'reply'|'tool', ts:string, text:string}>}>}
 * A turn with no trailing answer still appears with answer:'' — consumers
 * (artifact tabs) filter those out.
 */
export function groupTurns(records) {
  // ── flat event stream: you | reply | tool (same as the generator) ─────────
  const events = [];
  for (const rec of records || []) {
    if (!rec || rec.isSidechain === true) continue;   // sidechains: skip entirely
    const ts = rec.timestamp || '';
    const content = (rec.message || {}).content;
    if (rec.type === 'user') {
      for (const x of userTexts(rec)) events.push({ kind: 'you', ts, text: x });
    } else if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c) continue;
        if (c.type === 'text') {
          const x = String(c.text ?? '').trim();
          if (x) events.push({ kind: 'reply', ts, text: x });
        } else if (c.type === 'tool_use') {
          let inp = '';
          try { inp = JSON.stringify(c.input ?? {}).slice(0, TOOL_INPUT_PREVIEW); } catch { inp = '{…}'; }
          events.push({ kind: 'tool', ts, text: `${c.name || '?'} ${inp}` });
        }
      }
    }
  }

  // ── group into turns: a 'you' event starts a turn ──────────────────────────
  const raw = [];
  let cur = null;
  for (const ev of events) {
    if (ev.kind === 'you') {
      if (cur) raw.push(cur);
      cur = { q: ev, body: [] };
    } else if (cur) {
      cur.body.push(ev);
    }
  }
  if (cur) raw.push(cur);

  // ── per turn: trailing reply run = THE ANSWER; the rest = internals ───────
  return raw.map(({ q, body }) => {
    let cut = body.length;
    while (cut > 0 && body[cut - 1].kind === 'reply') cut--;
    const answerRun = body.slice(cut);
    const answer = answerRun.map((e) => e.text).join('\n\n').trim();
    return {
      q: q.text,
      qts: q.ts,
      ats: answerRun.length ? answerRun[answerRun.length - 1].ts : q.ts,
      answer,
      tools: body.reduce((n, e) => n + (e.kind === 'tool' ? 1 : 0), 0),
      title: titleOf(q.text),
      type: sniffType(answer),
      internals: body.slice(0, cut).map(({ kind, ts, text }) => ({ kind, ts, text }))
    };
  });
}

/** Title from the QUESTION: first md heading, else first non-blank line with
 *  md symbols stripped; capped at 70 chars. (Port of title_of.) */
function titleOf(text) {
  const s = String(text ?? '');
  const m = /^#{1,4}\s+(.+)$/m.exec(s);
  if (m) return m[1].trim().slice(0, TITLE_MAX);
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/[*`#]/g, '').slice(0, TITLE_MAX);
}
