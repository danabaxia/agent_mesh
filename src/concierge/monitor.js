/**
 * Pure monitor: raw mesh-health inputs → deduped, severity-ranked findings.
 * No I/O. Tolerant of missing/partial inputs (every arg optional).
 *
 * Spec: docs/superpowers/specs/2026-06-21-concierge-mesh-agent-design.md
 */
const SEV_RANK = { info: 0, warn: 1, critical: 2 };

function uniqBy(items, keyFn) {
  const seen = new Map();
  for (const it of items) { const k = keyFn(it); if (!seen.has(k)) seen.set(k, it); }
  return [...seen.values()];
}

/**
 * @param {object} inputs
 * @param {object} [inputs.conformance]  check_conformance result { ok, counts, problems[] }
 * @param {object} [inputs.triage]       triage_logs result { agents: { name: { failures, recent_failures } } }
 * @param {object} [inputs.staleTasks]   list_stale_tasks result { tasks: [{ id, to, state, age_ms }] }
 * @param {object} [inputs.mir]          optional MIR signal { regressed, summary }
 * @returns {Array<{id,severity,kind,summary,detail,source}>}
 */
export function buildFindings({ conformance, triage, staleTasks, mir } = {}) {
  const out = [];

  // Conformance fails → critical (one finding per distinct rule+detail).
  if (conformance && conformance.ok === false) {
    const problems = Array.isArray(conformance.problems) ? conformance.problems : [];
    const fails = uniqBy(problems.filter((p) => p && p.level === 'fail'), (p) => `${p.rule}|${p.detail}`);
    for (const p of fails) {
      out.push({ id: `conformance:${p.rule}:${p.detail}`, severity: 'critical', kind: 'conformance',
        summary: `Conformance fail: ${p.rule}`, detail: String(p.detail ?? ''), source: 'check_conformance' });
    }
    if (!fails.length && (conformance.counts?.fail > 0)) {
      out.push({ id: 'conformance:counts', severity: 'critical', kind: 'conformance',
        summary: `Conformance: ${conformance.counts.fail} failing`, detail: JSON.stringify(conformance.counts), source: 'check_conformance' });
    }
  }

  // Per-agent recent failures → warn.
  const agents = (triage && triage.agents) || {};
  for (const [name, a] of Object.entries(agents)) {
    const n = Number(a?.failures) || 0;
    if (n > 0) out.push({ id: `agent-failures:${name}`, severity: 'warn', kind: 'agent-failures',
      summary: `${name}: ${n} recent failure(s)`, detail: JSON.stringify(a.recent_failures ?? []).slice(0, 500), source: 'triage_logs' });
  }

  // Stale tasks → warn.
  const tasks = (staleTasks && staleTasks.tasks) || [];
  for (const t of tasks) {
    out.push({ id: `stale-task:${t.id}`, severity: 'warn', kind: 'stale-task',
      summary: `Stale task ${t.id} (${t.to}) — ${t.state}`, detail: `age_ms=${t.age_ms}`, source: 'list_stale_tasks' });
  }

  // MIR regression signal (optional) → warn.
  if (mir && mir.regressed) out.push({ id: 'mir:regression', severity: 'warn', kind: 'mir',
    summary: 'Test/MIR regression detected', detail: String(mir.summary ?? '').slice(0, 500), source: 'mir' });

  return out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}
