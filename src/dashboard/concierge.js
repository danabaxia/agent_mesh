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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { spawnFile } from '../process.js';
import { READ_TOOLS } from '../config.js';

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
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  if (!title) return null;
  let labels = Array.isArray(obj.labels)
    ? obj.labels.filter((l) => typeof l === 'string' && CONFIRM_LABELS.has(l))
    : [];
  if (labels.length === 0) labels = ['idea'];   // default to triage
  return { title, body, labels };
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
 * @param {string} opts.meshRoot
 * @param {Function} [opts.runAsk]   injectable ask runner (tests)
 * @param {Function} [opts.runGh]    injectable gh runner (tests)
 * @param {string}   [opts.persona]
 */
export function createConcierge({ meshRoot, runAsk = defaultRunAsk, runGh = defaultRunGh, persona = PERSONA } = {}) {
  return {
    /**
     * One conversational turn. Read-only — never files anything.
     * @returns {Promise<{reply:string, proposal:object|null}>}
     */
    async message({ history = [], text, signal } = {}) {
      if (typeof text !== 'string' || !text.trim()) {
        throw new ConciergeError('Empty message', { status: 400 });
      }
      if (text.length > MAX_TEXT_CHARS) {
        throw new ConciergeError('Message too long', { status: 400 });
      }
      const statusDigest = await readStatusDigest(meshRoot);
      const prompt = buildPrompt({ persona, statusDigest, history, text: text.trim() });
      const replyRaw = await runAsk({ prompt, meshRoot, signal });
      const proposal = parseProposal(replyRaw);
      return { reply: stripProposalFence(replyRaw) || replyRaw, proposal };
    },

    /**
     * Land a reviewed proposal as a GitHub issue. The ONLY write surface, fired
     * only on the owner's explicit Confirm tap.
     * @returns {Promise<{url:string, title:string, labels:string[]}>}
     */
    async confirm({ title, body = '', labels } = {}) {
      if (typeof title !== 'string' || !title.trim()) {
        throw new ConciergeError('A title is required', { status: 400 });
      }
      const safeLabels = validateLabels(labels);   // throws on disallowed label, pre-spawn
      const { url } = await runGh({ title: title.trim(), body: String(body), labels: safeLabels, meshRoot });
      return { url, title: title.trim(), labels: safeLabels };
    }
  };
}
