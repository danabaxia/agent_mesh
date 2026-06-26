// src/mesh-improvement/render.js — pure: MIR → human markdown with an idempotent marker.
export function renderMarkdown(mir) {
  const day = mir.at.slice(0, 10);
  const d = (v) => (typeof v === 'number' ? (v >= 0 ? `+${v}` : `${v}`) : '—');
  const s = mir.summary;
  const lines = [
    `<!-- mir:${day} -->`,
    `# Mesh Improvement Report — ${day}`,
    `commit \`${mir.ref?.commit ?? '?'}\` · baseline \`${mir.baseline?.commit ?? 'none'}\``, '',
    '| signal | value | Δ |', '|---|---|---|',
    `| tests green/red | ${s.tests.green}/${s.tests.red} | ${d(s.tests.delta)} |`,
    `| behavior passRate | ${s.behavior.passRate ?? '—'} | ${d(s.behavior.delta)} |`,
    `| adversarial | ${s.adversarial.invariantsPassed ?? '—'} | ${d(s.adversarial.delta)} |`,
    `| perf q/1k p50 | ${s.perf.quality_per_1k_tokens_p50 ?? '—'} | ${d(s.perf.delta)} |`,
    '', '## Fileable findings', '',
  ];
  const fileable = mir.findings.filter((f) => f.fileable);
  if (!fileable.length) lines.push('_None this run._');
  for (const f of fileable) {
    const m = f.metric;
    lines.push(f.tier === 'hard'
      ? `- **[${f.severity}]** \`${f.id}\` — ${f.evidence?.trace ?? f.cluster}`
      : `- **[${f.severity}]** \`${f.id}\` — ${m.name} ${m.value} (base ${m.baseline}, Δ ${m.deltaPct}%)`);
  }
  const improvements = mir.findings.filter((f) => f.cluster === 'perf-improvement');
  if (improvements.length) {
    lines.push('', '## Improvements this run', '');
    for (const f of improvements) {
      const m = f.metric;
      lines.push(`- **[info]** \`${f.id}\` — ${m.name} ${m.value} (base ${m.baseline}, Δ +${m.deltaPct}%)`);
    }
  }
  return lines.join('\n') + '\n';
}
