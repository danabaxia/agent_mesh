/**
 * src/dashboard/session-index.js
 * Discover + index an agent's Claude Code sessions (transcripts under
 * ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl) with mesh provenance.
 */
import { readFile, writeFile, mkdir, readdir, stat, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// Windows-safe transcript helpers moved to a shared module (spec §5.2); re-export
// for back-compat so existing importers of session-index keep working.
export { encodeProjectDir, resolveTranscript, countLines } from '../session-transcripts.js';
import { encodeProjectDir, resolveTranscript, countLines, parseTranscriptLine, occupancyFromTranscriptLine, usageFromTail, headroomPctOf } from '../session-transcripts.js';
import { readPositiveInt, DEFAULT_CONTEXT_WINDOW } from '../config.js';

// Provenance event store moved to shared module (spec §3: core delegate.js must
// tag framework spawns without importing dashboard code); re-export for back-compat.
export { recordEvent, readEvents, deriveProvenance } from '../session-provenance.js';
import { recordEvent, readEvents, deriveProvenance, sessionsDir } from '../session-provenance.js';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelsPath(meshRoot) {
  return join(sessionsDir(meshRoot), 'labels.json');
}

// ---------------------------------------------------------------------------
// Mesh-side session LABELS (user-chosen display names). Stored separately from
// Claude Code's own transcript so renaming never touches the .jsonl. Keyed by
// session UUID under the same per-mesh provenance dir.
// ---------------------------------------------------------------------------

const MAX_LABEL_CHARS = 80;

/** Tolerant read: missing/corrupt labels file → {}. Returns { [id]: name }. */
export async function readLabels(meshRoot) {
  try {
    const raw = await readFile(labelsPath(meshRoot), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
      return out;
    }
    return {};
  } catch { return {}; }
}

/**
 * Set (or, with an empty/blank name, remove) the label for a session. Validates
 * the id is a UUID; caps the name to MAX_LABEL_CHARS and strips control chars /
 * newlines so a label can't smuggle markup or break the rail row. Returns the
 * stored label (or null if removed).
 */
export async function setLabel(meshRoot, id, name) {
  if (!UUID_RE.test(id)) throw Object.assign(new Error('bad session id'), { code: 'bad_id' });
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
  const labels = await readLabels(meshRoot);
  if (clean) labels[id] = clean; else delete labels[id];
  const p = labelsPath(meshRoot);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(labels), { mode: 0o600 });
  return clean || null;
}

/** Remove a session's label (used on delete). No-op if none. */
export async function deleteLabel(meshRoot, id) {
  return setLabel(meshRoot, id, '');
}

// ---------------------------------------------------------------------------
// Session listing + transcript resolution (Task 3)
// ---------------------------------------------------------------------------

const MAX_SCAN_BYTES = 2 * 1024 * 1024; // preview-derivation cap (NOT the cursor)
const ACTIVE_WINDOW_MS = 60_000;

// Preview: turns (# user_text), firstPrompt, start/end times — byte-capped.
async function derivePreview(path, parseTranscriptLine) {
  const fh = await open(path, 'r');
  try {
    const s = await fh.stat();
    const cap = Math.min(s.size, MAX_SCAN_BYTES);
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, 0);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let turns = 0, firstPrompt = null;
    for (const l of lines) {
      for (const ev of parseTranscriptLine(l)) {
        if (ev.type === 'user_text') { turns++; if (firstPrompt == null) firstPrompt = String(ev.text).slice(0, 200); }
      }
    }
    // headroom source: last assistant usage. Only trustworthy when the buffer
    // holds the WHOLE file (cap === s.size); capped files fall back to a tail
    // read in listSessions (spec 2026-06-12 §3.3 — one read serves both).
    let occupancy = null;
    if (cap === s.size) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const occ = occupancyFromTranscriptLine(lines[i]);
        if (occ !== null) { occupancy = occ; break; }
      }
    }
    return { turns, firstPrompt, turnsApprox: s.size > MAX_SCAN_BYTES, startedAt: s.birthtimeMs || s.mtimeMs, endedAt: s.mtimeMs, mtimeMs: s.mtimeMs, size: s.size, occupancy };
  } finally { await fh.close(); }
}

const _cache = new Map(); // path → { size, mtimeMs, preview, lineCount, occupancy }

export async function listSessions(agentRoot, io = {}) {
  const platform = io.platform || process.platform;
  const meshRoot = io.meshRoot;
  const enc = encodeProjectDir(agentRoot, platform, io);
  const projDir = join(io.projectsDir || PROJECTS_DIR, enc);
  let names = [];
  try { names = (await readdir(projDir)).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  // Read events + labels ONCE and reuse for all sessions (not per-session).
  const events = meshRoot ? await readEvents(meshRoot) : [];
  const labels = meshRoot ? await readLabels(meshRoot) : {};
  const rows = [];
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, '');
    if (!UUID_RE.test(id)) continue;
    const path = join(projDir, name);
    const s = await stat(path);
    let entry = _cache.get(path);
    if (!entry || entry.size !== s.size || entry.mtimeMs !== s.mtimeMs) {
      const preview = await derivePreview(path, parseTranscriptLine);
      let occupancy = preview.occupancy;
      if (occupancy == null && preview.turnsApprox) {
        const u = await usageFromTail(path);   // 256 KB tail; cached with the entry
        occupancy = u ? u.occupancy : null;
      }
      entry = { size: s.size, mtimeMs: s.mtimeMs, preview, lineCount: await countLines(path), occupancy };
      _cache.set(path, entry);
    }
    const prov = deriveProvenance(events, id);
    rows.push({
      id, transcriptPath: path, lineCount: entry.lineCount,
      turns: entry.preview.turns, firstPrompt: entry.preview.firstPrompt, turnsApprox: entry.preview.turnsApprox,
      startedAt: entry.preview.startedAt, endedAt: entry.preview.endedAt,
      active: (Date.now() - entry.preview.mtimeMs) < ACTIVE_WINDOW_MS,
      originSource: prov.originSource, lastManagedBy: prov.lastManagedBy,
      label: labels[id] ?? null,
      headroomPct: entry.occupancy == null
        ? null
        : headroomPctOf(entry.occupancy, readPositiveInt(process.env.AGENT_MESH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW))
    });
  }
  rows.sort((a, b) => b.endedAt - a.endedAt);
  return rows;
}

/**
 * PERMANENTLY delete a session's real transcript (~/.claude/projects/.../<id>.jsonl).
 * The path is obtained ONLY via resolveTranscript (UUID + index-membership +
 * realpath containment) — never hand-joined — so the same security gate that
 * protects read/stream protects the unlink. Resolve errors (bad_id/not_found/
 * containment) propagate; the route maps them to 4xx. The preview/lineCount
 * cache entry for the deleted path is evicted so a recreated id can't show stale
 * data. Returns { ok: true }.
 */
export async function deleteSession(agentRoot, id, io = {}) {
  const real = await resolveTranscript(agentRoot, id, io);
  await unlink(real);
  // Evict cache. listSessions keys by the index-joined path (pre-realpath); the
  // resolved real path may differ under a symlink, so evict both keys.
  _cache.delete(real);
  const enc = encodeProjectDir(agentRoot, io.platform || process.platform, io);
  _cache.delete(join(io.projectsDir || PROJECTS_DIR, enc, `${id}.jsonl`));
  return { ok: true };
}

