/**
 * Mesh tools — the AUTOMATIC input/output surface the voice agent calls.
 *
 *  - fileMeshTask  : the agent files a real task into the mesh (gh issue, label-
 *                    allowlisted) → enters the dev-society evolve pipeline. (INPUT)
 *  - getMeshStatus : the agent reads what the mesh is doing (daily report + open
 *                    issues/PRs) and weaves it back into the conversation. (OUTPUT)
 *
 * These are the "自动输入输出 mesh" of the chain — no manual copy-paste.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- ask-only proxy to a real mesh agent, VIA THE DASHBOARD CONSOLE -----------
// We POST to the running dashboard's ask-only console (`/api/agent/<name>/message`,
// mode:'ask') instead of spawning our own broker. Why: the dashboard runs against
// the DEPLOY mesh and brokers the spawn itself, so the consult shows up as live
// dashboard activity (the in-process broker against the working-copy mesh was
// invisible to the dashboard). ask-only is enforced dashboard-side: the agent
// answers but never does work. Slow (~5s–min); actual work still goes via file_mesh_task.
const DASH_URL = process.env.VOICE_DASHBOARD_URL || 'http://127.0.0.1:7077';
const DEPLOY_MESH = process.env.VOICE_MESH_DIR || join(homedir(), '.agent-mesh', 'deploy', 'dev-mesh');
const DASH_TOKEN_FILE = process.env.VOICE_DASHBOARD_TOKEN_FILE || join(DEPLOY_MESH, '.agent-mesh', 'dashboard-token');
function dashToken() {
  if (process.env.VOICE_DASHBOARD_TOKEN) return process.env.VOICE_DASHBOARD_TOKEN;
  try { return readFileSync(DASH_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}
// Ask access to EVERY served agent — read the served list from the DEPLOY mesh the
// dashboard fronts (fall back to the working-copy mesh). Future agents auto-included.
function readServedAgents() {
  for (const dir of [DEPLOY_MESH, join(REPO_ROOT, 'dev-mesh')]) {
    try {
      const m = JSON.parse(readFileSync(join(dir, 'mesh.json'), 'utf8'));
      const a = (m.agents || []).filter((x) => x.served === true && x.name).map((x) => x.name);
      if (a.length) return a;
    } catch { /* try next */ }
  }
  return [];
}
const SERVED_AGENTS = readServedAgents();
function taskText(task) {
  const arts = (task?.artifacts || []).flatMap((a) => a?.parts || []).map((p) => p?.text).filter(Boolean).join('\n').trim();
  if (arts) return arts;
  const status = (task?.status?.message?.parts || []).map((p) => p?.text).filter(Boolean).join('\n').trim();
  return status || (typeof task?.summary === 'string' ? task.summary : '') || '(该 agent 未返回文本)';
}
export async function askMeshAgent({ agent, question } = {}) {
  const name = String(agent || '').toLowerCase();
  if (!SERVED_AGENTS.includes(name)) throw new Error(`unknown agent: ${agent}. options: ${SERVED_AGENTS.join(', ')}`);
  if (!question || !String(question).trim()) throw new Error('question required');
  const t0 = Date.now();
  console.log(`[ask] → ${name} (via dashboard): ${String(question).slice(0, 100)}`);
  try {
    const token = dashToken();
    if (!token) throw new Error('no dashboard token (set VOICE_DASHBOARD_TOKEN or the token file)');
    let res;
    try {
      res = await fetch(`${DASH_URL}/api/agent/${encodeURIComponent(name)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
        body: JSON.stringify({ text: String(question), mode: 'ask' }),
        signal: AbortSignal.timeout(Number(process.env.VOICE_ASK_TIMEOUT_MS) || 150000),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`${name} 想得太久没及时回复（可改用「建成任务」让它异步处理）`);
      throw e;
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(`console ${res.status}: ${d?.error?.message || d?.error?.code || ''}`);
    const answer = taskText(d.task).slice(0, 4000);
    console.log(`[ask] ← ${name} ok (${Date.now() - t0}ms): ${answer.slice(0, 120).replace(/\n/g, ' ')}`);
    return { agent: name, answer };
  } catch (e) {
    console.log(`[ask] ✗ ${name} (${Date.now() - t0}ms): ${String(e.message).slice(0, 200)}`);
    throw e;
  }
}

// Confine any caller-supplied path to the repo (no traversal escape).
function safeRepoPath(p) {
  const abs = resolve(REPO_ROOT, String(p || ''));
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path escapes repo: ' + p);
  return abs;
}
const LABEL_ALLOWLIST = new Set(['idea', 'approved', 'route:a2a']);

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO_ROOT, timeout: 30000, maxBuffer: 1 << 22, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${(stderr || err.message).slice(0, 300)}`));
      resolve(String(stdout));
    });
  });
}

/** File a task into the mesh as a GitHub issue. Labels are allowlisted; default `idea`. */
export async function fileMeshTask({ title, body = '', labels } = {}) {
  if (!title || !String(title).trim()) throw new Error('title required');
  let safe = Array.isArray(labels) ? labels.filter((l) => LABEL_ALLOWLIST.has(l)) : [];
  if (safe.length === 0) safe = ['idea'];
  const args = ['issue', 'create', '--title', String(title).trim(), '--body', String(body)];
  for (const l of safe) args.push('--label', l);
  const out = await sh('gh', args);
  const url = (out.match(/https?:\/\/\S+/) || [''])[0].trim();
  const number = (url.match(/\/(\d+)$/) || [])[1] || null;
  return { url, number, labels: safe };
}

/** Set allowlisted labels on an EXISTING issue (e.g. idea→approved+route:a2a to
 *  dispatch it to the dev-society for auto-building). Label-allowlisted, like filing. */
export async function setIssueLabels({ number, labels } = {}) {
  const num = String(number || '').replace(/^#/, '');
  if (!/^\d+$/.test(num)) throw new Error('valid issue number required');
  let safe = Array.isArray(labels) ? labels.filter((l) => LABEL_ALLOWLIST.has(l)) : [];
  if (safe.length === 0) throw new Error(`no allowlisted labels (options: ${[...LABEL_ALLOWLIST].join(', ')})`);
  const args = ['issue', 'edit', num];
  for (const l of safe) args.push('--add-label', l);
  await sh('gh', args);
  return { number: num, labels: safe, dispatched: safe.includes('route:a2a') };
}

/** Read what the mesh is currently doing: recent activity + open issues/PRs. */
export async function getMeshStatus() {
  const status = { openIssues: null, recentIssues: [], openPRs: null, daily: null };
  // Open issues/PRs via gh (fast, authoritative).
  try {
    const issues = JSON.parse(await sh('gh', ['issue', 'list', '--state', 'open', '--limit', '8', '--json', 'number,title,labels']));
    status.openIssues = issues.length;
    status.recentIssues = issues.map((i) => ({ number: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name) }));
  } catch { /* degrade */ }
  try {
    const prs = JSON.parse(await sh('gh', ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number']));
    status.openPRs = prs.length;
  } catch { /* degrade */ }
  // Daily report summary if present.
  const dr = join(REPO_ROOT, '.dev-society', 'daily-report.json');
  if (existsSync(dr)) {
    try {
      const d = JSON.parse(readFileSync(dr, 'utf8'));
      const t = d.tokens?.total ?? d.tokens;
      status.daily = {
        prsMerged: Array.isArray(d.prs?.merged) ? d.prs.merged.length : undefined,
        prsOpen: d.prs?.openNow,
        issuesOpen: d.issues?.openNow,
        costUsd: typeof t?.costUsd === 'number' ? Number(t.costUsd.toFixed(2)) : undefined,
      };
    } catch { /* degrade */ }
  }
  return status;
}

// --- READ-ONLY mesh/code exploration (so the agent can DISCUSS the real mesh) ---

/** List the mesh's agents (dev-mesh/<name>/) with their role from AGENT.md. */
export function listMeshAgents() {
  const dir = join(REPO_ROOT, 'dev-mesh');
  const agents = [];
  if (existsSync(dir)) {
    for (const ent of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
      const am = join(dir, ent.name, 'AGENT.md');
      if (!existsSync(am)) continue;   // a real agent has an AGENT.md
      const first = readFileSync(am, 'utf8').split('\n').find((l) => l.trim());
      agents.push({ name: ent.name, role: (first || '').replace(/^#\s*/, '').trim() });
    }
  }
  return { count: agents.length, agents };
}

/** Browse a repo directory (immediate entries; dirs end with /). */
export function listRepoTree({ dir = '' } = {}) {
  const abs = dir ? safeRepoPath(dir) : REPO_ROOT;
  if (!existsSync(abs)) throw new Error('not found: ' + dir);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort();
  return { dir: dir || '.', entries: entries.slice(0, 300) };
}

/** Read a repo file (text, size-capped, path-confined). */
export function readRepoFile({ path } = {}) {
  if (!path) throw new Error('path required');
  const abs = safeRepoPath(path);
  if (!existsSync(abs)) throw new Error('not found: ' + path);
  const content = readFileSync(abs, 'utf8');
  const cap = 12000;
  return { path, lines: content.split('\n').length, truncated: content.length > cap, content: content.slice(0, cap) };
}

/** Search the repo's tracked code (git grep). Returns file:line matches. */
export async function searchRepo({ query, max = 40 } = {}) {
  if (!query) throw new Error('query required');
  try {
    const out = await sh('git', ['grep', '-n', '-I', '--no-color', '-e', String(query)]);
    const matches = out.split('\n').filter(Boolean).slice(0, max);
    return { query, count: matches.length, matches, truncated: matches.length >= max };
  } catch { return { query, count: 0, matches: [], note: 'no matches' }; }
}

export const MESH_TOOL_DECLARATIONS = [
  {
    name: 'list_mesh_agents',
    description: 'List the mesh\'s agents (the dev-society team) and each one\'s role. Call this when the owner asks who/what is in the mesh or wants to understand its structure.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_repo_tree',
    description: 'Browse a directory of the mesh codebase (immediate entries). Top-level dirs include src/, dev-mesh/, hooks/, scripts/, docs/, bin/, mesh/. Call to explore structure before reading files.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: 'repo-relative dir, e.g. "src" or "src/dashboard"; empty = repo root' } } },
  },
  {
    name: 'read_repo_file',
    description: 'Read a source/doc file from the mesh codebase (text, truncated). Use to inspect actual code or design docs so you can discuss the real implementation.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative file path, e.g. "src/a2a/protocol.js" or "PROJECT.md"' } }, required: ['path'] },
  },
  {
    name: 'search_repo',
    description: 'Search the mesh codebase for a string/symbol (git grep). Returns file:line matches. Use to locate where something is implemented.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'literal text or symbol to find' } }, required: ['query'] },
  },
  {
    name: 'set_issue_labels',
    description: 'Set labels on an EXISTING mesh issue by number. Use this when the owner wants to advance/dispatch an existing issue — e.g. relabel an `idea` to `approved` + `route:a2a` so the dev-society auto-builds it. Labels are allowlisted (idea/approved/route:a2a). This is the only way to make the mesh act on an already-open issue.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'the issue number, e.g. "361"' },
        labels: { type: 'array', items: { type: 'string', enum: ['idea', 'approved', 'route:a2a'] }, description: 'labels to add; use ["approved","route:a2a"] to dispatch for auto-build' },
      },
      required: ['number', 'labels'],
    },
  },
  {
    name: 'ask_mesh_agent',
    description: 'ASK a real mesh agent a question and get ITS answer (ask-only — the agent reads/reasons and answers but does NOT do work). Use when the owner wants a specific agent\'s expert opinion/analysis (e.g. "ask the analyst…", "what does the tester think…"). SLOW: real agents run on claude (~30s–minutes), so tell the owner it will take a moment before calling. For actually getting work DONE, use file_mesh_task instead (async).',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: SERVED_AGENTS, description: 'which agent to ask' },
        question: { type: 'string', description: 'the question for that agent (English preferred)' },
      },
      required: ['agent', 'question'],
    },
  },
  {
    name: 'file_mesh_task',
    description: 'File a concrete task into the mesh as a GitHub issue so the dev-society pipeline (triage → spec → build → PR) picks it up. Call this when the owner has settled on something actionable. Title/body MUST be English. Use labels ["idea"] for something to triage first (default), or ["approved","route:a2a"] to dispatch straight to the agent team.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short English imperative title' },
        body: { type: 'string', description: 'clear English description: context, goal, acceptance criteria' },
        labels: { type: 'array', items: { type: 'string', enum: ['idea', 'approved', 'route:a2a'] }, description: 'optional; defaults to ["idea"]' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'get_mesh_status',
    description: 'Read what the mesh is currently doing — open issues/PRs, recent merges, 24h cost. Call this when the owner asks about mesh state or before proposing work, so you discuss against reality.',
    parameters: { type: 'object', properties: {} },
  },
];

export async function runMeshTool(name, args) {
  if (name === 'file_mesh_task') return fileMeshTask(args || {});
  if (name === 'get_mesh_status') return getMeshStatus();
  if (name === 'list_mesh_agents') return listMeshAgents();
  if (name === 'list_repo_tree') return listRepoTree(args || {});
  if (name === 'read_repo_file') return readRepoFile(args || {});
  if (name === 'search_repo') return searchRepo(args || {});
  if (name === 'ask_mesh_agent') return askMeshAgent(args || {});
  if (name === 'set_issue_labels') return setIssueLabels(args || {});
  throw new Error(`unknown tool: ${name}`);
}
