// src/dev-society/analyst-ideas.js — pure: agent idea-JSON → deduped GitHub
// issue-create plan. Mirrors src/mesh-improvement/issues.js. The model never
// reads issue bodies; markers are extracted host-side by extractMarkers.
const DEDUPE_RE = /^[a-z0-9:_-]+$/;
const MARKER_RE = /<!--\s*analyst-idea:([a-z0-9:_-]+)\s*-->/g;
const CAP = 2;

export function analystMarker(dedupeKey) {
  return `<!-- analyst-idea:${dedupeKey} -->`;
}

// Extract the last fenced ```json block and parse it as an array of ideas.
export function parseIdeas(agentOutput) {
  if (typeof agentOutput !== 'string' || !agentOutput) return [];
  const blocks = [...agentOutput.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  let parsed;
  try {
    parsed = JSON.parse(blocks[blocks.length - 1][1].trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { title, body, dedupeKey, labels } = item;
    if (typeof title !== 'string' || !title.trim()) continue;
    if (typeof dedupeKey !== 'string' || !DEDUPE_RE.test(dedupeKey)) continue;
    out.push({
      title: title.trim(),
      body: typeof body === 'string' ? body : '',
      dedupeKey,
      labels: Array.isArray(labels) ? labels.filter((l) => typeof l === 'string') : [],
    });
  }
  return out;
}

// Host-side, deterministic: pull every analyst-idea marker key from issue bodies.
export function extractMarkers(issues) {
  const set = new Set();
  for (const issue of issues || []) {
    const body = typeof issue?.body === 'string' ? issue.body : '';
    for (const m of body.matchAll(MARKER_RE)) set.add(m[1]);
  }
  return set;
}

// Plan create actions for ideas whose dedupeKey is not already open; cap at 2.
export function planIdeaIssues(ideas, openMarkers, { scanLabel = 'generated:analyst' } = {}) {
  const open = openMarkers instanceof Set ? openMarkers : new Set();
  const plan = [];
  for (const idea of ideas || []) {
    if (plan.length >= CAP) break;
    if (open.has(idea.dedupeKey)) continue;
    const marker = analystMarker(idea.dedupeKey);
    plan.push({
      action: 'create',
      title: idea.title,
      body: `${marker}\n\n${idea.body}`,
      labels: ['idea', scanLabel],
      marker,
    });
  }
  return plan;
}
