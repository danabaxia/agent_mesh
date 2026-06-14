// src/session-transcripts.js — shared Windows-safe transcript helpers.
//
// `encodeProjectDir` / `resolveTranscript` / `countLines` were moved here verbatim
// from src/dashboard/session-index.js (which now re-exports them for back-compat)
// so the A2A multi-turn path can resolve transcripts without importing dashboard
// code (boundary hygiene, spec §5.2). `transcriptExists` is a thin boolean wrapper.
// Also hosts `parseTranscriptLine` / `redactSessionEvent` (moved from
// src/dashboard/session-events.js, spec 2026-06-12 §5.1) and the headroom
// helpers (§3), so core modules use them without importing dashboard code.
import { readdir, realpath, open } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep as PATH_SEP } from 'node:path';
import { DEFAULT_CONTEXT_WINDOW } from './config.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Count newlines cheaply over the WHOLE file (the cursor is never capped).
export async function countLines(path) {
  const fh = await open(path, 'r');
  try {
    let count = 0; const buf = Buffer.alloc(65536); let pos = 0;
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) count++;
      pos += bytesRead;
    }
    return count;
  } finally { await fh.close(); }
}

/** UUID + index-only resolution + realpath containment under the agent's project dir. */
export async function resolveTranscript(agentRoot, id, io = {}) {
  if (!UUID_RE.test(id)) throw Object.assign(new Error('bad session id'), { code: 'bad_id' });
  const platform = io.platform || process.platform;
  // Canonicalize the agent root BEFORE encoding so the lookup matches the
  // id-derivation side (stdio-server deriveCallerSession / runDigest both encode
  // `await realpath(root)`). Without this, a root reachable via an 8.3 SHORT path
  // (GH Windows runners' os.tmpdir() returns e.g. RUNNER~1) encodes differently
  // from the LONG realpath form the writer used, and every lookup misses
  // (`not_found`/`transcript_unavailable`) — the Windows drive-letter-casing bug,
  // one level deeper. PROJECT.md invariant: identity is the realpath-canonical path.
  // Use the REAL fs realpath here (not io.realpath, which is the containment-check
  // seam for the candidate path below): on a non-existent fixture root realpath
  // throws and we fall back to the raw root, preserving existing fake-root tests.
  let canonRoot;
  try { canonRoot = await realpath(agentRoot); } catch { canonRoot = agentRoot; }
  const enc = encodeProjectDir(canonRoot, platform, io);
  const projDir = join(io.projectsDir || PROJECTS_DIR, enc);
  // Index-only: check the directory listing before any realpath call.
  let names;
  try { names = await readdir(projDir); } catch { throw Object.assign(new Error('unknown session'), { code: 'not_found' }); }
  if (!names.includes(`${id}.jsonl`)) throw Object.assign(new Error('unknown session'), { code: 'not_found' });
  const candidate = join(projDir, `${id}.jsonl`);
  const rp = io.realpath || realpath;
  let real;
  try { real = await rp(candidate); } catch { throw Object.assign(new Error('unknown session'), { code: 'not_found' }); }
  const realDir = await rp(projDir).catch(() => projDir);
  // Anchor the prefix with the PLATFORM separator so `-proj` can't match a sibling
  // `-projMalicious` (startsWith without a boundary is a path-prefix bypass). Using
  // a hardcoded '/' broke this on Windows, where realpath returns '\\'-separated
  // paths — every transcript was rejected with `containment` (404) and the
  // session-log board stayed empty.
  const boundary = realDir.endsWith(PATH_SEP) ? realDir : realDir + PATH_SEP;
  if (real !== realDir && !real.startsWith(boundary)) {
    throw Object.assign(new Error('path escapes project dir'), { code: 'containment' });
  }
  return real;
}

/** Boolean wrapper over resolveTranscript (which returns a path / throws not_found). */
export async function transcriptExists(agentRoot, id, io = {}) {
  try { await resolveTranscript(agentRoot, id, io); return true; }
  catch (e) { if (e && e.code === 'not_found') return false; throw e; }
}

// Cap how much transcript countTurns reads — it is observability only (the
// multi-turn `agentmesh/metrics.turn` stamp), so a byte-capped count on a
// pathological transcript is acceptable; correctness-critical readers must
// not reuse this.
const MAX_COUNT_BYTES = 4 * 1024 * 1024;

/**
 * Count the conversation turns (`user_text` events — typed prompts, NOT
 * tool_results) in a session's transcript. One turn spans many .jsonl lines,
 * so this is NOT a line count. Returns null when the transcript does not
 * exist or cannot be read — callers omit the metric rather than fail.
 */
export async function countTurns(agentRoot, id, io = {}) {
  let path;
  try { path = await resolveTranscript(agentRoot, id, io); }
  catch { return null; }
  try {
    const fh = await open(path, 'r');
    try {
      const s = await fh.stat();
      const cap = Math.min(s.size, MAX_COUNT_BYTES);
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, 0);
      let turns = 0;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        for (const ev of parseTranscriptLine(line)) if (ev.type === 'user_text') turns++;
      }
      return turns;
    } finally { await fh.close(); }
  } catch { return null; }
}

// ── transcript parsing + render redaction (moved verbatim from
// src/dashboard/session-events.js — spec 2026-06-12 §5.1 boundary hygiene:
// countTurns (this module) and the forthcoming src/digest-extract.js use these without importing dashboard code;
// session-events re-exports them for back-compat) ───────────────────────────
// Trust model: defense-in-depth on an operator-owned localhost session, not a
// hard boundary (dashboard spec §7).

const MAX_FIELD_CHARS = 20_000;
const MAX_FIELD_LINES = 400;

// Secret-shaped substrings → replaced with «redacted». Conservative, additive.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{4,}/g,                  // OpenAI-style (and similar sk- prefixed keys)
  /ghp_[A-Za-z0-9]{20,}/g,                  // GitHub PAT
  /AKIA[0-9A-Z]{16}/g,                      // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,          // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Fa-f0-9]{32,}\b/g,                  // long hex secrets/tokens
  /\b[A-Za-z0-9_-]{16,}=[A-Za-z0-9/+_-]{12,}/g // KEY=secretish-value
];

function scrubString(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
  return out;
}

function capString(s) {
  let str = String(s);
  if (str.length > MAX_FIELD_CHARS) {
    const head = str.slice(0, MAX_FIELD_CHARS);
    str = `${head}\n… ${str.length - MAX_FIELD_CHARS} more chars`;
  }
  const lines = str.split('\n');
  if (lines.length > MAX_FIELD_LINES) {
    str = lines.slice(0, MAX_FIELD_LINES).join('\n') + `\n… ${lines.length - MAX_FIELD_LINES} more lines`;
  }
  return str;
}

// Recurse over every string in a value, applying scrub + cap. Objects/arrays
// rebuilt; non-strings passed through. A depth guard prevents a pathologically
// nested payload (JSON.parse imposes no depth limit) from overflowing the stack
// and crashing the dashboard process. Scrub BEFORE cap so a secret straddling
// the cap boundary cannot leave an un-scrubbed prefix in the rendered head.
const MAX_REDACT_DEPTH = 100;
function redactValue(v, depth = 0) {
  if (typeof v === 'string') return capString(scrubString(v));
  if (depth > MAX_REDACT_DEPTH) return '[redacted: too deep]';
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val, depth + 1);
    return out;
  }
  return v;
}

/**
 * Parse one line of a Claude Code SESSION TRANSCRIPT (`~/.claude/projects/<dir>/
 * <uuid>.jsonl`) — a DIFFERENT, internal format from `-p --output-format
 * stream-json`. Transcript lines are wrapped records with types like
 * `user`/`assistant`/`system`/`mode`/`attachment`/`last-prompt`. We surface the
 * human-readable conversation: the typed prompt (`user_text`), assistant text /
 * tool calls, and tool results. Everything else → ignored (empty array).
 * Tolerant: malformed → `raw`, never throws.
 * @returns {Array<object>}
 */
export function parseTranscriptLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return [{ type: 'raw', raw: String(line) }]; }
  try {
    const content = msg.message?.content;
    // Thread the record-level timestamp + sidechain flag onto each event so the
    // turn-grouping session view (board2 Phase 7) can rebuild Q→A timing and
    // skip sub-agent records WITHOUT shipping the raw (unredacted) JSONL to the
    // browser. Strictly additive: when the source record lacks the field,
    // nothing is attached, so existing consumers/tests see identical shapes.
    const extra = {};
    if (typeof msg.timestamp === 'string') extra.ts = msg.timestamp;
    if (msg.isSidechain === true) extra.sidechain = true;
    if (msg.type === 'user') {
      // A plain string is the human's typed prompt; an array carries tool_results.
      if (typeof content === 'string') return content.trim() ? [{ type: 'user_text', text: content, ...extra }] : [];
      if (Array.isArray(content)) {
        const out = [];
        for (const b of content) {
          if (b.type === 'text' && String(b.text || '').trim()) out.push({ type: 'user_text', text: b.text, ...extra });
          else if (b.type === 'tool_result') out.push({ type: 'tool_result', toolUseId: b.tool_use_id, content: b.content, ...extra });
        }
        return out;
      }
      return [];
    }
    if (msg.type === 'assistant' && Array.isArray(content)) {
      const out = [];
      for (const b of content) {
        if (b.type === 'text' && String(b.text || '').trim()) out.push({ type: 'text', text: b.text, ...extra });
        else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input, ...extra });
      }
      return out;
    }
    // mode / permission-mode / attachment / last-prompt / system / etc. → ignored
    return [];
  } catch {
    return [{ type: 'raw', raw: String(line) }];
  }
}

// Allowlist the fields that render per type, then recursively cap+scrub them.
const RENDER_FIELDS = {
  init: ['model', 'cwd'],
  text: ['text'],
  user_text: ['text'],
  tool_use: ['name', 'input'],
  tool_result: ['toolUseId', 'content'],
  turn_done: ['result'],
  error: ['code', 'message'],
  raw: ['raw']
};

export function redactSessionEvent(ev) {
  const fields = RENDER_FIELDS[ev.type] || Object.keys(ev).filter((k) => k !== 'type');
  const out = { type: ev.type };
  for (const f of fields) if (f in ev) out[f] = redactValue(ev[f]);
  // carry non-rendered control fields through untouched (seq/turnId/isError/id;
  // ts/sidechain are transcript-record metadata threaded by parseTranscriptLine)
  for (const k of ['seq', 'turnId', 'isError', 'id', 'sessionId', 'ts', 'sidechain']) if (k in ev) out[k] = ev[k];
  return out;
}

// ── headroom (spec 2026-06-12 §3) ──────────────────────────────────────────
const HEADROOM_TAIL_BYTES = 256 * 1024;

/** Sum the input-side usage fields. null when usage carries no input signal. */
export function occupancyFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const a = usage.input_tokens, b = usage.cache_read_input_tokens, c = usage.cache_creation_input_tokens;
  if (typeof a !== 'number' && typeof b !== 'number' && typeof c !== 'number') return null;
  const n = (a ?? 0) + (b ?? 0) + (c ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Clamped integer headroom percent. null when inputs carry no signal. */
export function headroomPctOf(occupancy, contextWindow = DEFAULT_CONTEXT_WINDOW) {
  if (!Number.isFinite(occupancy) || occupancy <= 0) return null;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.max(0, Math.round((1 - occupancy / contextWindow) * 100));
}

/** Occupancy from ONE raw transcript JSONL line (assistant records carry
 *  message.usage — parseTranscriptLine deliberately drops it, so parse raw). */
export function occupancyFromTranscriptLine(line) {
  try {
    const msg = JSON.parse(line);
    if (msg?.type !== 'assistant') return null;
    return occupancyFromUsage(msg.message?.usage);
  } catch { return null; }
}

/**
 * Best-effort: last assistant usage within the final `tailBytes` of the file.
 * Returns { occupancy, atMtime } or null. Display/metrics only — never a
 * correctness-critical reader (byte-capped like countTurns).
 */
export async function usageFromTail(path, { tailBytes = HEADROOM_TAIL_BYTES } = {}) {
  try {
    const fh = await open(path, 'r');
    try {
      const s = await fh.stat();
      const cap = Math.min(s.size, tailBytes);
      if (cap === 0) return null;
      const offset = s.size - cap;
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, offset);
      let text = buf.toString('utf8');
      if (offset > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        const occ = occupancyFromTranscriptLine(lines[i]);
        if (occ !== null) return { occupancy: occ, atMtime: s.mtimeMs };
      }
      return null;
    } finally { await fh.close(); }
  } catch { return null; }
}

/**
 * Headroom for one session. null on any missing/unreadable/usage-less state
 * (callers omit the metric) — EXCEPT containment, which propagates: a path
 * escaping the project dir is a security signal, not a degrade case.
 */
export async function readSessionHeadroom(agentRoot, id, io = {}) {
  let path;
  try { path = await resolveTranscript(agentRoot, id, io); }
  catch (e) { if (e && e.code === 'containment') throw e; return null; }
  const u = await usageFromTail(path, io.tailBytes ? { tailBytes: io.tailBytes } : {});
  if (!u) return null;
  const pct = headroomPctOf(u.occupancy, io.contextWindow || DEFAULT_CONTEXT_WINDOW);
  return pct === null ? null : { occupancy: u.occupancy, headroomPct: pct, atMtime: u.atMtime };
}

// ---------------------------------------------------------------------------
// encodeProjectDir
// ---------------------------------------------------------------------------

/**
 * Encode a launch cwd into Claude Code's project-dir name. Claude prefixes the
 * encoded name with `-` (a leading separator), so we do too:
 *   darwin/linux: replace `/` and `.` with `-`; win32: replace `\`, `/`, `:`, `.`.
 * If the computed dir is absent, fall back to an **exact** alternate-scheme match
 * (the path's components joined by `-`, with a leading `-`) — this covers a likely
 * scheme drift (e.g. dots kept rather than dashed) while AVOIDING the partial
 * `endsWith` collisions that could return a *different* same-user project's dir
 * (e.g. `/agent` matching `-Users-me-agent`). Containment is still realpath-checked
 * downstream by `resolveTranscript`.
 */
export function encodeProjectDir(canonicalRoot, platform = process.platform, io = {}) {
  const projectsDir = io.projectsDir || PROJECTS_DIR;
  // Claude Code encodes the launch cwd by replacing EVERY non-alphanumeric
  // character with '-'. On POSIX the leading '/' yields the leading '-'; on
  // Windows the drive letter means there is NO leading '-':
  //   /Users/me/agent      → -Users-me-agent
  //   C:\AI\agents_mesh\x   → C--AI-agents-mesh-x
  // The previous scheme replaced only [\\/:.] (missing '_' and others) and
  // force-prefixed '-', so on Windows it computed a directory name that never
  // existed — listSessions/resolveTranscript then found nothing and the
  // session-log view stayed empty even though Claude had written the transcript.
  const computed = String(canonicalRoot).replace(/[^a-zA-Z0-9]/g, '-');
  try {
    if (existsSync(join(projectsDir, computed))) return computed;
    // Case-insensitive exact-match fallback for drive-letter / path-casing drift
    // (Windows paths can surface with either drive-letter case). Anchored
    // equality — never a loose suffix — so it can't pick a sibling project.
    const ci = platform === 'win32';
    for (const name of readdirSync(projectsDir)) {
      if (name === computed || (ci && name.toLowerCase() === computed.toLowerCase())) return name;
    }
  } catch { /* projectsDir may not exist yet → use computed */ }
  return computed;
}
