// eval/scorecard.mjs — scoring + report rendering (spec §6).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function aggregate(scenarioReports) {
  const scenarios = scenarioReports.map((s) => {
    if (s.compare) return s;                               // A/B entries pass through
    const passed = s.trials.filter((t) => t.pass).length;
    return { ...s, passed, passRate: s.trials.length ? passed / s.trials.length : null };
  });
  const scored = scenarios.filter((s) => !s.compare);
  const trials = scored.reduce((n, s) => n + s.trials.length, 0);
  const passed = scored.reduce((n, s) => n + s.passed, 0);
  return {
    at: new Date().toISOString(),
    scenarios,
    aggregate: { trials, passed, casesExecuted: trials, passRate: trials ? passed / trials : null }
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

export function renderMarkdown(report) {
  const lines = [`# A2A behavior eval — ${report.at}`, '',
    `**Aggregate: ${report.aggregate.passed}/${report.aggregate.trials} trials (${pct(report.aggregate.passRate)})**`, '',
    '| scenario | result | detail |', '|---|---|---|'];
  for (const s of report.scenarios) {
    if (s.compare) {
      const arms = Object.entries(s.compare)
        .map(([arm, v]) => {
          const parts = [`del ${pct(v.delegationRate)}`];
          if (v.rightPeerRate !== undefined) parts.push(`right ${pct(v.rightPeerRate)}`);
          if (v.wrongPeerRate) parts.push(`wrong ${pct(v.wrongPeerRate)}`);
          if (v.answerRate !== undefined) parts.push(`ans ${pct(v.answerRate)}`);
          if (v.errorRate) parts.push(`err ${pct(v.errorRate)}`);
          return `${arm}: ${parts.join('/')}`;
        }).join(' · ');
      lines.push(`| ${s.name} | A/B | ${arms} |`);
      continue;
    }
    const fails = s.trials.filter((t) => !t.pass)
      .map((t) => `t${t.trial}: ${(t.probes.find((p) => !p.pass) || {}).name || '?'}`).join('; ');
    lines.push(`| ${s.name} | ${s.passed}/${s.trials.length} (${pct(s.passRate)}) | ${fails || 'all pass'} |`);
  }
  return lines.join('\n') + '\n';
}

export async function writeScorecard(outDir, report) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'scorecard.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'scorecard.md'), renderMarkdown(report));
  return { json: join(outDir, 'scorecard.json'), md: join(outDir, 'scorecard.md') };
}

/** 0 unless zero cases executed (exits 2 when zeroIsError) or threshold not met (exits 1). */
export function exitCode(report, minPassRate, { zeroIsError = false } = {}) {
  if (zeroIsError && report.aggregate.casesExecuted === 0) return 2;
  if (minPassRate === undefined || minPassRate === null) return 0;
  return report.aggregate.passRate >= Number(minPassRate) ? 0 : 1;
}
