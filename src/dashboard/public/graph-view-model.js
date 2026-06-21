// PURE view-model math for the Graph view (tokens / issues KPIs). No DOM, no fetch.
export function issuesLabel(issues) {
  const n = (issues && Number.isFinite(issues.openNow)) ? issues.openNow : 0;
  return `${n} open total`;
}
export function tokenTotal(tokens) {
  const series = tokens && Array.isArray(tokens.series) ? tokens.series : [];
  return series.reduce((sum, p) => sum + (Number.isFinite(p?.value) ? p.value : 0), 0);
}
