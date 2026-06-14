// src/dev-mesh/backlog-mirror.js — PURE renderer of docs/superpowers/backlog.md
// from a GitHub Issues snapshot (spec §5.4: Issues are the source of truth; the
// markdown file is a generated mirror). Deterministic: stable section order +
// issues sorted by number, so re-rendering an unchanged snapshot is a no-op diff.
import { STATES, deriveState, summarize } from './backlog.js';

// Display order of sections (idea → done), with off-path states last.
const SECTION_ORDER = [
  STATES.IDEA, STATES.DISCUSSING, STATES.SPEC_DRAFT, STATES.SPEC_IN_REVIEW,
  STATES.APPROVED, STATES.IN_PROGRESS, STATES.PR_IN_REVIEW,
  STATES.BLOCKED, STATES.DONE, STATES.REJECTED, 'unknown'
];

const HEADINGS = {
  [STATES.IDEA]: 'Ideas',
  [STATES.DISCUSSING]: 'Discussing',
  [STATES.SPEC_DRAFT]: 'Spec — draft',
  [STATES.SPEC_IN_REVIEW]: 'Spec — in review',
  [STATES.APPROVED]: 'Approved (ready)',
  [STATES.IN_PROGRESS]: 'In progress',
  [STATES.PR_IN_REVIEW]: 'PR in review',
  [STATES.BLOCKED]: 'Blocked',
  [STATES.DONE]: 'Done',
  [STATES.REJECTED]: 'Rejected',
  unknown: 'Unlabeled'
};

const titleOf = (i) => String(i?.title ?? '').trim() || '(untitled)';
const assigneeSuffix = (i) => {
  const a = i?.assignees || (i?.assignee ? [i.assignee] : []);
  const names = a.map((x) => (typeof x === 'string' ? x : x?.login)).filter(Boolean);
  return names.length ? ` _(@${names.join(', @')})_` : '';
};

/**
 * Render the backlog mirror as Markdown. `issues` is a snapshot of GitHub Issues
 * ({ number, title, labels, assignees }). Pure + deterministic.
 */
export function renderBacklog(issues = [], { heading = 'Backlog' } = {}) {
  const counts = summarize(issues);
  const groups = new Map();
  for (const issue of issues) {
    const s = deriveState(issue) || 'unknown';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(issue);
  }

  const lines = [];
  lines.push(`# ${heading}`, '');
  lines.push('> Generated mirror of GitHub Issues — **do not edit by hand** (Issues are the source of truth).', '');

  // Summary line: counts in section order, only non-zero.
  const summaryParts = SECTION_ORDER
    .filter((s) => counts[s])
    .map((s) => `${HEADINGS[s]}: ${counts[s]}`);
  lines.push(`**Totals:** ${summaryParts.length ? summaryParts.join(' · ') : '(empty)'}`, '');

  for (const state of SECTION_ORDER) {
    const items = groups.get(state);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => (a.number || 0) - (b.number || 0));
    lines.push(`## ${HEADINGS[state]}`, '');
    for (const i of items) lines.push(`- #${i.number} ${titleOf(i)}${assigneeSuffix(i)}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}
