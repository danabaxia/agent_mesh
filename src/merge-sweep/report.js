import { join } from 'node:path';

export function mergeSweepReportPath(meshRoot) {
  return join(meshRoot, 'mesh', 'reports', 'merge-sweep.json');
}

// checkpoints: [{ name, status:'clean'|'flagged'|'error', error?, items:[{ref,number,state,detail}] }]
// prev: the previous report object ({} if none). now: Date. Pure.
export function buildMergeSweepReport(checkpoints, prev, now) {
  const iso = now.toISOString();
  const prevByName = Object.fromEntries(((prev && prev.checkpoints) || []).map((c) => [c.name, c]));
  const out = checkpoints.map((c) => {
    const prevItems = (prevByName[c.name] && prevByName[c.name].items) || [];
    const prevByRef = Object.fromEntries(prevItems.map((i) => [i.ref, i]));
    const items = (c.items || []).map((it) => {
      const p = prevByRef[it.ref];
      const same = p && p.state === it.state && p.state !== 'resolved';
      return { ...it, firstSeen: same ? p.firstSeen : iso, ageRuns: same ? (p.ageRuns || 1) + 1 : 1 };
    });
    const curRefs = new Set(items.map((i) => i.ref));
    for (const p of prevItems) {
      if (p.state !== 'resolved' && !curRefs.has(p.ref)) {
        items.push({ ref: p.ref, number: p.number, state: 'resolved', detail: '', firstSeen: iso, ageRuns: 1 });
      }
    }
    const status = c.status === 'error' ? 'error'
      : items.some((i) => i.state !== 'resolved') ? 'flagged' : 'clean';
    return { name: c.name, status, error: c.error || null, items };
  });
  const summary = out.reduce((s, c) => {
    if (c.status === 'error') s.errors++; else if (c.status === 'flagged') s.flagged++; else s.ok++; return s;
  }, { ok: 0, flagged: 0, errors: 0 });
  return { ranAt: iso, mode: 'report', cadenceMinutes: 15, checkpoints: out, summary };
}
