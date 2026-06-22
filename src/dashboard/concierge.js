/**
 * Mesh Concierge — the phone front-door's conversational + intake surface.
 *
 * Spec: docs/superpowers/specs/2026-06-21-mesh-mobile-concierge-design.md
 *
 * Two operations, both reached from the mobile PWA over Tailscale:
 *
 *  - `message({ history, text })` → runs ONE ask-only `claude` turn (read tools
 *    only, no repo writes). The reply may contain a fenced ```concierge-proposal
 *    JSON block — a *proposal* (title/body/labels) the owner reviews. Parsing a
 *    proposal NEVER files anything; it is surfaced for the owner to confirm.
 *
 *  - `confirm({ title, body, labels })` → the SINGLE write surface. Runs
 *    `gh issue create` with an allowlisted label set, landing the idea in the
 *    existing evolve pipeline. Fires only on the owner's explicit Confirm tap.
 *
 * Design invariants:
 *  - The concierge ask spawn is read-only (READ_TOOLS) — it cannot write the repo.
 *  - Issue creation is framework-side and label-allowlisted; the model never runs
 *    an arbitrary `gh` subcommand.
 *  - Failure is data: ask/gh failures throw ConciergeError carrying a status code,
 *    surfaced to the UI as an error bubble — nothing is silently lost or filed.
 */

import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { spawnFile } from '../process.js';
import { READ_TOOLS, DEFAULT_CONCIERGE_HISTORY_MAX, DEFAULT_CONCIERGE_CONTEXT_TURNS } from '../config.js';
import { dispatchAction } from '../concierge/dispatch.js';
import { createTask as boardCreateTask } from '../board/store.js';

// The served mesh agent the dashboard routes phone chat to (when a broker is wired).
const CONCIERGE_AGENT = 'concierge';
const PROPOSAL_ACTIONS = new Set(['file_issue', 'assign_task', 'ask_peer_rerun']);

// ── Pure history helpers (exported for tests) ─────────────────────────────

export function parseHistoryLines(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split('\n').flatMap((line) => {
    const l = line.trim();
    if (!l) return [];
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

export function serializeHistoryLines(entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

export function trimEntries(entries, max) {
  return entries.length <= max ? entries : entries.slice(entries.length - max);
}

export function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = entry.role === 'assistant'
    ? (entry.reply ?? entry.text ?? '')
    : (entry.text ?? '');
  return { role: entry.role, text: String(text), ts: entry.ts ?? null };
}

export class ConciergeError extends Error {
  constructor(message, { status = 500, detail } = {}) {
    super(message);
    this.name = 'ConciergeError';
    this.status = status;
    this.detail = detail;
  }
}

// Only these labels may be applied by a confirm. `idea` → triage queue;
// `approved`+`route:a2a` → released straight to the daemon's build pipeline.
export const CONFIRM_LABELS = new Set(['idea', 'approved', 'route:a2a']);

const PROPOSAL_FENCE = /```concierge-proposal\s*\n([\s\S]*?)\n```/;
const MAX_TEXT_CHARS = 8_000;     // per owner message
const MAX_HISTORY_TURNS = 40;     // bound the embedded transcript
const MAX_HISTORY_CONTEXT = 10;   // server-side turns loaded into buildPrompt for continuity
const ASK_TIMEOUT_MS = 120_000;

/**
 * Extract a `{ title, body, labels[] }` proposal from a concierge reply, or null.
 * A malformed / absent block yields null (the reply is then a plain chat turn).
 * @param {string} replyText
 * @returns {{title:string, body:string, labels:string[]}|null}
 */
export function parseProposal(replyText) {
  if (typeof replyText !== 'string') return null;
  const m = replyText.match(PROPOSAL_FENCE);
  if (!m) return null;
  let obj;
  try {
    obj = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  // Action type — defaults to file_issue (back-compat with title/body/labels proposals).
  const action = (typeof obj.action === 'string' && PROPOSAL_ACTIONS.has(obj.action)) ? obj.action : 'file_issue';

  if (action === 'assign_task') {
    const peer = typeof obj.peer === 'string' ? obj.peer.trim() : '';
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const objective = typeof obj.objective === 'string' ? obj.objective : '';
    if (!peer || !title || !objective) return null;
    return { action, peer, title, objective,
      context: typeof obj.context === 'string' ? obj.context : '',
      requirements: typeof obj.requirements === 'string' ? obj.requirements : '',
      pointers: typeof obj.pointers === 'string' ? obj.pointers : '' };
  }
  if (action === 'ask_peer_rerun') {
    const peer = typeof obj.peer === 'string' ? obj.peer.trim() : '';
    const task = typeof obj.task === 'string' ? obj.task.trim() : '';
    if (!peer || !task) return null;
    return { action, peer, task };
  }

  // file_issue (default)
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  if (!title) return null;
  let labels = Array.isArray(obj.labels)
    ? obj.labels.filter((l) => typeof l === 'string' && CONFIRM_LABELS.has(l))
    : [];
  if (labels.length === 0) labels = ['idea'];   // default to triage
  return { action, title, body, labels };
}

/**
 * Validate a confirm body's labels against the allowlist. Throws ConciergeError(400)
 * on any unknown label — BEFORE any `gh` spawn.
 * @param {unknown} labels
 * @returns {string[]}
 */
export function validateLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return ['idea'];
  for (const l of labels) {
    if (typeof l !== 'string' || !CONFIRM_LABELS.has(l)) {
      throw new ConciergeError(`Disallowed label: ${JSON.stringify(l)}`, { status: 400 });
    }
  }
  return [...new Set(labels)];
}

// Strip the reply's proposal fence so the chat bubble shows prose, not raw JSON.
function stripProposalFence(replyText) {
  return typeof replyText === 'string' ? replyText.replace(PROPOSAL_FENCE, '').trim() : '';
}

// --------------------------------------------------------------------------
// Server-side conversation history (spec issue #362).
// Stored as newline-delimited JSON under <meshRoot>/mesh/concierge/history.jsonl.
// Pure read/write helpers — best-effort; any failure must not break message().
// --------------------------------------------------------------------------

async function readHistory(historyPath, { limit = 20 } = {}) {
  try {
    const raw = await readFile(historyPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function appendHistory(historyPath, entries, { max = DEFAULT_CONCIERGE_HISTORY_MAX } = {}) {
  await mkdir(dirname(historyPath), { recursive: true });
  await appendFile(historyPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  // LRU trim: keep at most `max` entries. Read → slice → atomic-ish rewrite.
  try {
    const raw = await readFile(historyPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > max) {
      await writeFile(historyPath, lines.slice(-max).join('\n') + '\n', 'utf8');
    }
  } catch { /* trim failure is non-fatal */ }
}

// Build a compact status digest from the dev-society status files (best-effort —
// any missing/unreadable file is simply omitted). Keeps the ask prompt cheap.
async function readStatusDigest(meshRoot) {
  const lines = [];
  const tryRead = async (rel) => {
    try { return JSON.parse(await readFile(join(meshRoot, rel), 'utf8')); }
    catch { return null; }
  };
  const daily = await tryRead('.dev-society/daily-report.json');
  if (daily) {
    const s = daily.summary ?? daily;
    lines.push(`daily-report: ${JSON.stringify(s).slice(0, 600)}`);
  }
  const beat = await tryRead('.dev-society/heartbeat.json');
  if (beat) {
    lines.push(`health: ${JSON.stringify(beat.status ?? beat).slice(0, 400)}`);
  }
  return lines.length ? lines.join('\n') : '(no status files found yet)';
}

const PERSONA = [
  'You are the Mesh Concierge — the phone front-door for an autonomous developer mesh',
  'that runs 24/7 on the owner\'s Mac and evolves itself (idea -> spec -> build -> PR -> merge).',
  'Help the owner DISCUSS ideas, RELAY instructions, and REVIEW status, conversationally.',
  'Be concise; you are on a phone screen.',
  '',
  'When — and only when — the owner converges on a concrete idea or instruction they want',
  'to act on, emit a proposal as a fenced block exactly like:',
  '```concierge-proposal',
  '{"title": "<short imperative title>", "body": "<clear description for the mesh>", "labels": ["idea"]}',
  '```',
  'Use labels ["idea"] for something to triage first (the default). Use ["approved","route:a2a"]',
  'ONLY if the owner explicitly says to build it now. Never invent a proposal the owner did not ask for;',
  'if they are just chatting or asking status, reply normally with no fenced block.'
].join('\n');

function buildPrompt({ persona, statusDigest, history, text }) {
  const turns = (Array.isArray(history) ? history : [])
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => `${m.role === 'assistant' ? 'Concierge' : 'Owner'}: ${String(m.text ?? '').slice(0, MAX_TEXT_CHARS)}`)
    .join('\n');
  return [
    persona,
    '',
    'Current mesh status:',
    statusDigest,
    '',
    turns ? `Conversation so far:\n${turns}\n` : '',
    `Owner: ${text}`
  ].join('\n');
}

// Default ask runner: one read-only `claude -p` turn, JSON envelope parsed for the
// final text. Read tools only — the concierge can inspect the repo but never write.
async function defaultRunAsk({ prompt, meshRoot, signal }) {
  const claude = process.env.AGENT_MESH_CLAUDE || 'claude';
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', READ_TOOLS.join(',')];
  const res = await spawnFile(claude, args, { cwd: meshRoot, timeoutMs: ASK_TIMEOUT_MS, signal });
  if (res.error) throw new ConciergeError(`concierge ask failed: ${res.error.message}`, { status: 502 });
  if (res.code !== 0) throw new ConciergeError('concierge ask did not complete', { status: 502, detail: (res.stderr || '').slice(0, 500) });
  const out = (res.stdout || '').trim();
  try {
    const env = JSON.parse(out);
    if (env && typeof env.result === 'string') return env.result;
  } catch { /* not an envelope — fall through to raw text */ }
  return out;
}

// Default issue creator: `gh issue create` in the mesh root (repo inferred from the
// git remote). Returns the new issue URL printed on stdout.
async function defaultRunGh({ title, body, labels, meshRoot }) {
  const args = ['issue', 'create', '--title', title, '--body', body || title];
  for (const l of labels) args.push('--label', l);
  const res = await spawnFile('gh', args, { cwd: meshRoot, timeoutMs: 30_000 });
  if (res.error) throw new ConciergeError(`gh failed: ${res.error.message}`, { status: 502 });
  if (res.code !== 0) throw new ConciergeError('gh issue create failed', { status: 502, detail: (res.stderr || '').slice(0, 500) });
  const url = (res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  return { url };
}

/**
 * Create a concierge bound to one mesh root.
 * @param {object} opts
 * @param {string}   opts.meshRoot
 * @param {Function} [opts.runAsk]          injectable ask runner (tests)
 * @param {Function} [opts.runGh]           injectable gh runner (tests)
 * @param {string}   [opts.persona]
 * @param {string}   [opts.historyPath]     override the JSONL path (tests)
 * @param {number}   [opts.historyMax]      override entry cap (tests)
 * @param {Function} [opts.appendHistory]   injectable appender (root, entries, max) — tests
 * @param {Function} [opts.loadHistory]     injectable loader (root, limit) → entries — tests
 * @param {number}   [opts.contextTurns]    turns injected into each prompt (tests)
 */
export function createConcierge({
  meshRoot,
  broker,                       // when set, message() routes to the served concierge AGENT (A2A)
  peers = [],                   // the concierge agent's mesh peers (for the action dispatcher)
  runAsk = defaultRunAsk,
  runGh = defaultRunGh,
  createTask = boardCreateTask,
  persona = PERSONA,
  historyPath,
  historyMax,
  appendHistory: _appendHistoryFn,
  loadHistory: _loadHistoryFn,
  contextTurns,
} = {}) {
  const _historyPath = historyPath ?? join(meshRoot, 'mesh', 'concierge', 'history.jsonl');
  const _historyMax = historyMax ?? (Number(process.env.AGENT_MESH_CONCIERGE_HISTORY_MAX) || DEFAULT_CONCIERGE_HISTORY_MAX);
  const _contextTurns = contextTurns ?? (Number(process.env.AGENT_MESH_CONCIERGE_CONTEXT_TURNS) || DEFAULT_CONCIERGE_CONTEXT_TURNS);

  // Dispatch: use injectable I/O when provided (unit tests), else file-based (integration).
  const _doAppend = _appendHistoryFn
    ? (entries) => _appendHistoryFn(meshRoot, entries, _historyMax)
    : (entries) => appendHistory(_historyPath, entries, { max: _historyMax });
  const _doLoad = _loadHistoryFn
    ? (limit) => _loadHistoryFn(meshRoot, limit)
    : (limit) => readHistory(_historyPath, { limit });

  return {
    /**
     * One conversational turn. Read-only — never files anything.
     * Loads the last `_contextTurns` turns from server-side storage into the
     * prompt for cross-session continuity, and appends the new exchange after reply.
     * @returns {Promise<{reply:string, proposal:object|null}>}
     */
    async message({ text, signal } = {}) {
      if (typeof text !== 'string' || !text.trim()) {
        throw new ConciergeError('Empty message', { status: 400 });
      }
      if (text.length > MAX_TEXT_CHARS) {
        throw new ConciergeError('Message too long', { status: 400 });
      }
      const userTs = new Date().toISOString();
      // Load server-side history for continuity — the model sees the last _contextTurns
      // turns regardless of whether the client kept them in memory.
      const serverHistory = await _doLoad(_contextTurns).catch(() => []);
      let replyRaw;
      if (broker) {
        // Route to the served concierge AGENT. Its AGENT.md carries the persona and it
        // reads status itself via its peer bridge + mesh-health tools, so we send a LEAN
        // text (history + the owner's question) — no embedded persona/status digest.
        const turns = serverHistory
          .map((m) => `${m.role === 'assistant' ? 'Concierge' : 'Owner'}: ${String(m.reply ?? m.text ?? '').slice(0, MAX_TEXT_CHARS)}`)
          .join('\n');
        const agentText = turns ? `${turns}\nOwner: ${text.trim()}` : text.trim();
        try {
          const res = await broker.send({ agentName: CONCIERGE_AGENT, mode: 'ask', text: agentText, signal });
          replyRaw = res?.task?.summary ?? '';
        } catch (e) {
          throw new ConciergeError(`concierge agent error: ${e.message}`, { status: 502 });
        }
      } else {
        // Fallback (no agent wired / tests): the local read-only ask spawn.
        const statusDigest = await readStatusDigest(meshRoot);
        const prompt = buildPrompt({ persona, statusDigest, history: serverHistory, text: text.trim() });
        replyRaw = await runAsk({ prompt, meshRoot, signal });
      }
      const proposal = parseProposal(replyRaw);
      const reply = stripProposalFence(replyRaw) || replyRaw;
      // Persist this turn (best-effort: never fail the response on a log write error).
      // Store assistant entries with both `text` and `reply` for cross-API compatibility.
      // Awaited so callers can read getHistory() immediately after message() completes.
      await _doAppend([
        { role: 'user', text: text.trim(), ts: userTs },
        { role: 'assistant', text: reply, reply, ts: new Date().toISOString() },
      ]).catch(() => {});
      return { reply, proposal };
    },

    /**
     * Return the last `limit` history entries from the server-side log (raw entries).
     * @returns {Promise<Array<{role:string,text:string,reply?:string,ts:string}>>}
     */
    async getHistory({ limit = 20 } = {}) {
      return readHistory(_historyPath, { limit: Math.max(1, Math.min(limit, 200)) });
    },

    /**
     * Return the last `limit` history entries from the server-side log (normalized).
     * @returns {Promise<Array<{role:string,text:string,ts:string}>>}
     */
    async history({ limit = 20 } = {}) {
      return readHistory(_historyPath, { limit: Math.max(1, Math.min(limit, 200)) });
    },

    /**
     * Perform a reviewed action — the ONLY write surface, fired only on the owner's
     * Confirm tap. Validates the action + allowlists BEFORE any side effect.
     * Back-compat: a bare `{ title, body, labels }` (no `action`) means `file_issue`.
     * @returns {Promise<object>}  dispatcher result (issue URL / task id / peer summary)
     */
    async confirm({ action, payload, title, body, labels, peer, objective, task, context, requirements, pointers } = {}) {
      const a = action ?? 'file_issue';
      const p = payload ?? { title, body, labels, peer, objective, task, context, requirements, pointers };
      return dispatchAction({ action: a, payload: p, meshRoot, deps: { runGh, broker, createTask, peers } });
    }
  };
}
