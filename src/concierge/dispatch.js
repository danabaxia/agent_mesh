/**
 * Confirm-gated action dispatcher for the concierge. The agent only PROPOSES;
 * this runs framework-side on the owner's Confirm tap, with allowlists checked
 * BEFORE any side effect. The agent never performs these itself.
 *
 * Spec: docs/superpowers/specs/2026-06-21-concierge-mesh-agent-design.md
 */
import { extractTaskText } from '../a2a/protocol.js';

export class DispatchError extends Error {
  constructor(message, { status = 400 } = {}) { super(message); this.name = 'DispatchError'; this.status = status; }
}

const LABELS = new Set(['idea', 'approved', 'route:a2a']);
const ACTIONS = new Set(['file_issue', 'assign_task', 'ask_peer_rerun']);

/**
 * @param {object} a
 * @param {'file_issue'|'assign_task'|'ask_peer_rerun'} a.action
 * @param {object} a.payload
 * @param {string} a.meshRoot
 * @param {object} a.deps  { runGh, broker:{send}, createTask, peers:string[] }
 */
export async function dispatchAction({ action, payload = {}, meshRoot, deps }) {
  if (!ACTIONS.has(action)) throw new DispatchError(`unknown action: ${action}`, { status: 400 });
  const { runGh, broker, createTask, peers = [] } = deps;

  if (action === 'file_issue') {
    const title = String(payload.title ?? '').trim();
    if (!title) throw new DispatchError('title required', { status: 400 });
    const raw = Array.isArray(payload.labels) ? payload.labels : [];
    for (const l of raw) {                       // reject (don't silently strip) — matches validateLabels
      if (typeof l !== 'string' || !LABELS.has(l)) throw new DispatchError(`Disallowed label: ${JSON.stringify(l)}`, { status: 400 });
    }
    const labels = raw.length ? [...new Set(raw)] : ['idea'];
    const { url } = await runGh({ title, body: String(payload.body ?? title), labels, meshRoot });
    return { ok: true, kind: 'file_issue', url };
  }

  if (action === 'assign_task') {
    const peer = String(payload.peer ?? '');
    if (!peers.includes(peer)) throw new DispatchError(`peer not allowed: ${peer}`, { status: 400 });
    if (!String(payload.title ?? '').trim() || !String(payload.objective ?? '').trim())
      throw new DispatchError('title + objective required', { status: 400 });
    const { id } = await createTask(meshRoot, { from: 'concierge', to: peer,
      title: String(payload.title), objective: String(payload.objective),
      context: String(payload.context ?? ''), requirements: String(payload.requirements ?? ''), pointers: String(payload.pointers ?? '') });
    return { ok: true, kind: 'assign_task', task_id: id, to: peer };
  }

  // ask_peer_rerun — reuse the console A2A broker (served-only/ask-only gates already in place)
  const peer = String(payload.peer ?? '');
  if (!peers.includes(peer)) throw new DispatchError(`peer not allowed: ${peer}`, { status: 400 });
  const task = String(payload.task ?? '').trim();
  if (!task) throw new DispatchError('task required', { status: 400 });
  const res = await broker.send({ agentName: peer, mode: 'ask', text: task });
  return { ok: true, kind: 'ask_peer_rerun', peer, summary: extractTaskText(res?.task) };
}
