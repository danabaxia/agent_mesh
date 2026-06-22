// Pure view-model for the A2A Task Board. No DOM, no fetch. Shared by desktop + phone.
// Spec: docs/superpowers/specs/2026-06-22-a2a-task-board-view-design.md
export const TASK_COLUMNS = [
  { state: 'assigned',     label: 'Assigned' },
  { state: 'acknowledged', label: 'Acknowledged' },
  { state: 'in-progress',  label: 'In progress' },
  { state: 'done',         label: 'Done' },
];
const ORDER = TASK_COLUMNS.map((c) => c.state);

export function relAge(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function lastAt(task) {
  const h = Array.isArray(task?.history) ? task.history : [];
  return h.length ? h[h.length - 1]?.at : (task?.created_at ?? null);
}

function toCard(task, now) {
  const at = Date.parse(lastAt(task) ?? '');
  return {
    id: task?.id ?? '(no id)',
    title: task?.title ?? '(untitled)',
    from: task?.from ?? '?',
    to: task?.to ?? '?',
    state: task?.state ?? 'unknown',
    ageMs: Number.isFinite(at) ? Math.max(0, now - at) : 0,
    hasResult: task?.result != null && task.result !== '',
  };
}

/**
 * Group tasks into state columns (canonical order, then any unknown-state columns).
 * @param {Array} tasks
 * @param {{now?:number}} [opts]
 * @returns {{columns:Array<{state,label,cards:Array}>, summary:{total:number}}}
 */
export function buildTaskBoard(tasks, { now = Date.now() } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const cards = list.map((t) => toCard(t, now));
  const summary = { total: cards.length };
  const colMap = new Map(TASK_COLUMNS.map((c) => [c.state, { ...c, cards: [] }]));
  for (const card of cards) {
    if (!colMap.has(card.state)) colMap.set(card.state, { state: card.state, label: card.state, cards: [] });
    colMap.get(card.state).cards.push(card);
    summary[card.state] = (summary[card.state] ?? 0) + 1;
  }
  for (const col of colMap.values()) col.cards.sort((a, b) => a.ageMs - b.ageMs);   // newest-first
  const ordered = [
    ...ORDER.map((s) => colMap.get(s)),
    ...[...colMap.values()].filter((c) => !ORDER.includes(c.state)),
  ];
  return { columns: ordered, summary };
}
