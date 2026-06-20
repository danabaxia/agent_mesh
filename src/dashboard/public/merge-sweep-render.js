const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REPO = 'danabaxia/agent_mesh';

export function renderMergeSweep(rep) {
  if (!rep || rep.available === false) return '<div class="gv-empty">no merge-sweep report yet</div>';
  const s = rep.summary || {};
  const head = `<div class="ms-head">flagged ${s.flagged || 0} · clean ${s.ok || 0} · report-only${rep.stale ? ' <span class="ms-stale">stale</span>' : ''}</div>`;
  const rows = (rep.checkpoints || []).map((c) => {
    const items = (c.items || []).map((it) => {
      const n = Number.isInteger(it.number) ? it.number : null;
      const link = n ? `<a href="https://github.com/${REPO}/pull/${n}" target="_blank" rel="noopener">${esc(it.ref)}</a>` : esc(it.ref);
      const age = (it.ageRuns || 1) > 1 ? ` · ${it.ageRuns} runs` : '';
      const rem = it.remediation
        ? ` <span class="ms-rem ms-rem-${esc(it.remediation.state)}">${esc(it.remediation.state)}${it.remediation.issueNumber ? ` <a href="https://github.com/${REPO}/issues/${Number(it.remediation.issueNumber)}" target="_blank" rel="noopener">#${Number(it.remediation.issueNumber)}</a>` : ''}</span>`
        : '';
      return `<div class="ms-item"><span class="ms-state ms-${esc(it.state)}">${esc(it.state)}</span> ${link} <span class="ms-detail">${esc(it.detail)}</span><span class="ms-age">${age}</span>${rem}</div>`;
    }).join('');
    return `<div class="ms-cp"><div class="ms-cp-h"><b>${esc(c.name)}</b> <span class="ms-status ms-st-${esc(c.status)}">${esc(c.status)}</span></div>${items}</div>`;
  }).join('');
  return head + rows;
}
