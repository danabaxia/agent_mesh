// src/dev-society/ci-schedules.js — pure: parse GH Actions cron workflows + enrich
// last-run/status from the gh-activity cache. No I/O, no Date.now().

const unquote = (s) => String(s).trim().replace(/^['"]|['"]$/g, '');

/** Extract a cron scalar value, comment-safe: prefer the quoted scalar, else strip a trailing ` #…`. */
function cronValue(afterColon) {
  const m = afterColon.match(/^\s*(['"])(.*?)\1/);          // quoted: take inside, ignore trailing comment
  if (m) return m[2];
  return afterColon.replace(/\s+#.*$/, '').trim();          // unquoted: strip inline comment
}

/** The workflow's purpose = its leading `#` comment block (above/around `name:`), so the
 * dashboard can hover each GitHub Action's "what it's for". Stops at the first body key. */
export function headerComment(lines = []) {
  const out = [];
  for (const raw of lines) {
    const t = String(raw).trim();
    if (!t) continue;                              // skip blank lines
    if (t.startsWith('#')) { const c = t.replace(/^#+\s?/, '').trim(); if (c) out.push(c); continue; }
    if (/^name:/.test(t)) continue;                // keep scanning past the name line
    break;                                          // first real body key (on:/jobs:/…) → header done
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Indentation/section-aware scan: top-level name + crons inside on.schedule only. */
export function parseCronWorkflows(files = []) {
  const out = [];
  for (const f of files) {
    const lines = String(f?.text ?? '').split('\n');
    let workflow = '';
    let inOn = false, onIndent = -1, inSchedule = false, scheduleIndent = -1;
    const crons = [];
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();
      const isComment = trimmed.startsWith('#');
      // top-level name (column 0)
      if (indent === 0 && /^name:/.test(trimmed) && !workflow) workflow = unquote(trimmed.slice(5));
      // track top-level `on:` (key at column 0)
      if (indent === 0) {
        inOn = /^on:/.test(trimmed);
        onIndent = inOn ? 0 : -1;
        inSchedule = false; scheduleIndent = -1;
        continue;
      }
      if (!inOn) continue;
      // inside on: find schedule: child (deeper than on)
      if (!isComment && /^schedule:/.test(trimmed) && indent > onIndent) {
        inSchedule = true; scheduleIndent = indent; continue;
      }
      // leaving schedule block: a key at <= schedule indent that isn't a list item
      if (inSchedule && indent <= scheduleIndent && !trimmed.startsWith('-')) inSchedule = false;
      if (inSchedule && !isComment) {
        const cm = trimmed.match(/^-?\s*cron:(.*)$/);
        if (cm) crons.push(cronValue(cm[1]));
      }
    }
    if (crons.length) out.push({ workflow: workflow || String(f.name).replace(/\.ya?ml$/, ''), file: f.name, crons, description: headerComment(lines) });
  }
  return out;
}

export function normalizeCiStatus(conclusion) {
  if (conclusion === 'success') return 'ok';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'fail';
  return null;
}

export function latestCiRuns(ghActivity = []) {
  const arr = Array.isArray(ghActivity) ? ghActivity : [];
  const edgeStatus = new Map();      // "<id>:e" → status
  for (const r of arr) if (r && typeof r.id === 'string' && r.id.endsWith(':e')) edgeStatus.set(r.id, r.status ?? null);
  const byName = new Map();
  for (const r of arr) {
    if (!r || typeof r.route !== 'string' || !r.route.startsWith('ci:') || (r.id || '').endsWith(':e')) continue;
    const name = r.route.slice(3);
    const prev = byName.get(name);
    if (prev && String(prev._started) >= String(r.started_at || '')) continue;
    byName.set(name, {
      _started: r.started_at || '',
      lastRunAt: r.finished_at || r.started_at || null,
      running: !r.finished_at,
      status: normalizeCiStatus(edgeStatus.get(`${r.id}:e`)),
    });
  }
  for (const v of byName.values()) delete v._started;
  return byName;
}

export function listCiSchedules({ files = [], ghActivity = [] } = {}) {
  const runs = latestCiRuns(ghActivity);
  return parseCronWorkflows(files)
    .map((w) => {
      const r = runs.get(w.workflow) || {};
      return {
        executor: 'GitHub Actions',
        workflow: w.workflow, file: w.file, cron: w.crons, description: w.description || '',
        cadenceLabel: 'cron ' + w.crons.join(', '),
        lastRunAt: r.lastRunAt ?? null, running: !!r.running, status: r.status ?? null,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
