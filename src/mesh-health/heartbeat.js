// Pure: classify the mesh-wide schedule list into health findings, the
// minimal-safe heals to apply, and the de-duped GitHub-issue escalations.
// Zero I/O — the only clock is the injected `now`. The impure runner
// (heartbeat-runner.js) feeds it `listAllSchedules` jobs + the prev snapshot.

const keyOf = (agent, jobId, condition) => `mesh-heartbeat:${agent}/${jobId}/${condition}`;

function classify(j, t, { staleMs, overdueGraceMs, failThreshold }) {
  const running = j.running === true;
  const lastRunMs = Date.parse(j.lastRunAt || '');
  const nextRunMs = Date.parse(j.nextRunAt || '');
  if (running && Number.isFinite(lastRunMs) && (t - lastRunMs) > staleMs) return 'stuck';
  if ((j.consecutiveFailures || 0) >= failThreshold) return 'failing';
  if (!running && Number.isFinite(nextRunMs) && (t - nextRunMs) > overdueGraceMs) return 'overdue';
  return null;
}

function detailFor(j, condition) {
  if (condition === 'stuck') return `running since ${j.lastRunAt} (stale lock)`;
  if (condition === 'failing') return `${j.consecutiveFailures} consecutive failures; last: ${j.lastSummary || j.lastStatus}`;
  if (condition === 'overdue') return `nextRunAt ${j.nextRunAt} is overdue and not arming`;
  return '';
}

/**
 * @param {object} args
 * @param {object[]} args.jobs  listAllSchedules().jobs (mesh-wide)
 * @param {Date}     args.now
 * @param {object}   args.thresholds  { failThreshold, overdueGraceMs, staleMs, escalateAfter }
 * @param {object|null} args.prev  previous snapshot { findings, openEscalations } (or null)
 * @returns {{ findings:object[], heals:object[], escalations:object[], openEscalations:string[], summary:object }}
 */
export function assessMeshHealth({ jobs, now = new Date(), thresholds = {}, prev = null }) {
  const { failThreshold = 3, overdueGraceMs = 900_000, staleMs = 1_800_000, escalateAfter = 2 } = thresholds;
  const t = now.getTime();
  const prevFindings = new Map((prev?.findings ?? []).map((f) => [keyOf(f.agent, f.jobId, f.condition), f]));
  const prevOpen = new Set(prev?.openEscalations ?? []);

  const findings = [], heals = [], escalations = [];
  const summary = { ok: 0, failing: 0, overdue: 0, stuck: 0, escalated: 0 };
  const nextOpen = new Set();

  for (const j of (Array.isArray(jobs) ? jobs : [])) {
    if (!j || j.enabled === false) { summary.ok++; continue; }
    const condition = classify(j, t, { staleMs, overdueGraceMs, failThreshold });
    if (!condition) { summary.ok++; continue; }
    summary[condition]++;

    const key = keyOf(j.agent, j.id, condition);
    const prevF = prevFindings.get(key);
    const seenCount = (prevF?.seenCount ?? 0) + 1;
    const since = prevF?.since ?? now.toISOString();
    const severity = seenCount >= escalateAfter ? 'error' : 'warn';
    const detail = detailFor(j, condition);
    findings.push({
      agent: j.agent, jobId: j.id, condition, severity, detail, since, seenCount,
      ...(condition === 'failing' ? { consecutiveFailures: j.consecutiveFailures || 0 } : {}),
    });

    if (condition === 'stuck') heals.push({ agent: j.agent, jobId: j.id, action: 'clear_stale', reason: detail });
    if (condition === 'overdue') heals.push({ agent: j.agent, jobId: j.id, action: 'rearm', reason: detail });

    if (seenCount >= escalateAfter) {
      escalations.push({
        agent: j.agent, jobId: j.id, condition, key,
        action: prevOpen.has(key) ? 'update' : 'open',
        title: `[mesh-heartbeat] ${j.agent}/${j.id}: ${condition}`,
        body: `${detail}\n\n<!-- ${key} -->`,
      });
      nextOpen.add(key);
      summary.escalated++;
    }
  }

  for (const key of prevOpen) {
    if (!nextOpen.has(key)) escalations.push({ key, action: 'close', body: `Resolved by mesh-heartbeat.\n\n<!-- ${key} -->` });
  }

  return { findings, heals, escalations, openEscalations: [...nextOpen], summary };
}
