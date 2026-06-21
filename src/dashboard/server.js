/**
 * src/dashboard/server.js
 *
 * Shell (I/O, Node http) — read-only dashboard HTTP server.
 *
 * Usage:
 *   const srv = createDashboardServer({ meshRoot, port, token });
 *   await srv.start();
 *   // srv.url  → e.g. "http://127.0.0.1:7077"
 *   // srv.close() → stops the server
 */

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, readdir, stat, realpath, mkdir, writeFile, rm, unlink, open } from 'node:fs/promises';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, relative, resolve, extname, dirname, basename, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { readManifest } from '../builder/manifest.js';
import { discoverAgentStructure } from '../agent-context.js';
import { buildAgentCard } from '../a2a/protocol.js';
import { isPathInsideRoot } from '../path-guard.js';
import {
  meshView,
  treeView,
  resourcesView,
  skillsView,
  mcpsView,
  isSensitivePath
} from './data.js';
import { extractSkillSummary, listLocalSkills } from '../agent-context.js';
import { createConsoleBroker, ConsoleError } from './console.js';
import { createConcierge, ConciergeError } from './concierge.js';
import { createMeshWatcher } from './watcher.js';
import { buildActivity } from './activity.js';
import { buildActivityStats, rangeBounds } from './activity-stats.js';
import { createShellLauncher } from './shell-launcher.js';
import { createSessionRunner } from './session-runner.js';
import { listSessions as defaultListSessions, resolveTranscript as defaultResolveTranscript, recordEvent as defaultRecordEvent, deleteSession as defaultDeleteSession, setLabel as defaultSetLabel, deleteLabel as defaultDeleteLabel, readLabels as defaultReadLabels, encodeProjectDir } from './session-index.js';
import { createSessionMirror } from './session-mirror.js';
import { createSessionLive } from './session-live.js';
import { parseTranscriptLine, redactSessionEvent } from './session-events.js';
import { readSessionId, writeSessionId } from './session-store.js';
import { readRunLogRecords, dedupeRunRecords } from '../log.js';
import { aggregateRange } from '../report/tokens-range.js';
import { MAX_TASK_CHARS, DEFAULT_AUTOSYNC_DEBOUNCE_MS, readPositiveInt, readDashboardAllowedHosts } from '../config.js';
import { createAutoSync } from './auto-sync.js';
import { doctor } from '../builder/doctor.js';
import { fetchRemoteImage, defaultPinnedFetch } from './img-proxy.js';
import { createScheduler } from '../schedule/scheduler.js';
import { validateCadence, describeCadence } from '../schedule/schedule-cadence.js';
import { listAllSchedules } from '../schedule/list-all.js';
import { listCiSchedules } from '../dev-society/ci-schedules.js';
import { markJobDue } from '../schedule/run-now.js';
import { createRotationManager } from './rotation.js';
import { runDigest } from '../digest.js';
import { buildResumeCommand } from './resume-command.js';
import { readActivity } from '../activity-log/log.js';
import { filterEvents } from '../activity-log/event.js';
import { readMergeSweepApi } from './merge-sweep-api.js';
import { collectHealth } from './health-collect.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_SIZE_CAP = 512 * 1024; // 512 KB
const COOKIE_NAME = 'am_dash';

// Console request-body cap: the brokered task text can be at most MAX_TASK_CHARS,
// plus a small allowance for the JSON envelope ({"text":...,"mode":"ask"}).
const CONSOLE_BODY_CAP = MAX_TASK_CHARS + 1024;

// Absolute path to this file's directory (ESM-safe)
const __dirname = dirname(fileURLToPath(import.meta.url));

// Public directory: src/dashboard/public/
const PUBLIC_DIR = join(__dirname, 'public');

// MIME types for static assets
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

// MIME map for deliverable previews (/api/agent/:name/deliverable). HTML gets
// an additional `Content-Security-Policy: sandbox` header at the route so the
// iframe preview cannot run scripts or reach the network.
const DELIVERABLE_MIME = {
  '.html': 'text/html',
  '.md':   'text/plain',
  '.txt':  'text/plain',
  '.log':  'text/plain',
  '.csv':  'text/csv',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml'
};

// Artifact save (/api/agent/:name/artifacts POST): allowed result types per the
// Phase-3 storage contract; body cap is generous because text-source artifacts
// carry the content inline (embed threshold below + JSON envelope headroom).
const ARTIFACT_TYPES = new Set(['report', 'table', 'chart', 'diff', 'file']);
const ARTIFACT_BODY_CAP = 256 * 1024;
const ARTIFACT_TEXT_EMBED_CAP = 64 * 1024; // text sources ≤64KB embed into artifact.md

// Validation invariant (Phase-3 plan): artifact ids / workflow slugs must match
// this — anything else is rejected before any filesystem path is built.
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Artifact id slug from the title: lowercase, every non-alphanumeric run → one
// '-', leading/trailing '-' trimmed, capped at 40 chars (re-trimmed so the cap
// cannot leave a dangling '-'). All-symbol titles slug to '' — the route falls
// back to 'artifact'.
function artifactSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

// Validation invariant shared by every id/slug-addressed artifact/workflow
// route: the ARTIFACT_ID_RE shape AND no '..' anywhere (the regex alone admits
// 'a..b'). Reject with 400 before any filesystem path is built.
function isSafeArtifactId(id) {
  return typeof id === 'string' && ARTIFACT_ID_RE.test(id) && !id.includes('..');
}

// Schedule storage (Phase-5 contract, mirrors src/schedule/scheduler.js):
// job definitions at <agentRoot>/.agent/schedule.json { jobs:[…] } (git-tracked
// intent), runtime state at <agentRoot>/.agent-mesh/schedule-state.json (never
// in git). Missing/corrupt defs are tolerated as empty.
const scheduleDefsPath = (agentRoot) => join(agentRoot, '.agent', 'schedule.json');
const scheduleStatePath = (agentRoot) => join(agentRoot, '.agent-mesh', 'schedule-state.json');

async function readScheduleFile(agentRoot) {
  try {
    const parsed = JSON.parse(await readFile(scheduleDefsPath(agentRoot), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed;
  } catch { /* missing/corrupt → empty */ }
  return { jobs: [] };
}

async function writeScheduleFile(agentRoot, defs) {
  await mkdir(dirname(scheduleDefsPath(agentRoot)), { recursive: true });
  await writeFile(scheduleDefsPath(agentRoot), JSON.stringify(defs, null, 2) + '\n', 'utf8');
}

// Workflow frontmatter (Phase-3 storage contract): a '---'-delimited block of
// `key: value` lines where `inputs` is a JSON string array, followed by a
// '# Decision frame' heading and a numbered step list. Hand-rolled — no YAML
// dependency. Returns null when the text does not open with a frontmatter
// block (listers skip such files); malformed inputs degrade to [].
function parseWorkflowMd(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;

  const meta = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  let inputs = [];
  try {
    const parsed = JSON.parse(meta.inputs || '[]');
    if (Array.isArray(parsed)) inputs = parsed.filter((x) => typeof x === 'string');
  } catch { /* malformed inputs → [] */ }

  // frame = the numbered-list lines after '# Decision frame', 'N. ' stripped.
  const frame = [];
  const body = lines.slice(end + 1);
  const fi = body.findIndex((l) => l.trim() === '# Decision frame');
  if (fi !== -1) {
    for (const l of body.slice(fi + 1)) {
      const m = l.match(/^\d+\.\s+(.*)$/);
      if (m) frame.push(m[1]);
    }
  }

  return {
    title: meta.title || '',
    purpose: meta.purpose || '',
    inputs,
    frame,
    promoted_from: meta.promoted_from || '',
    created: meta.created || '',
    // Dashboard-MANAGED workflows carry name:+title: keys. Agent-internal
    // recipe files (e.g. data-analyst's hand-authored flows with only a
    // description: key) are NOT managed and must not appear in the tab —
    // they rendered as blank-titled cards before this flag existed.
    managed: Boolean(meta.name && meta.title)
  };
}

// Default locate action for /api/agent/:name/deliverable/locate: open Windows
// File Explorer with the file selected. explorer.exe's /select syntax wants
// `/select,C:\full\path` as a SINGLE argument; never build a shell string.
// Injectable via createDashboardServer({ spawnLocate }) so tests record calls
// instead of launching a real Explorer window.
function defaultSpawnLocate(fullPath) {
  spawn('explorer.exe', ['/select,' + fullPath], { detached: true, stdio: 'ignore' }).unref();
}

// Default Daily Mesh Report regenerator for POST /api/daily/refresh: run
// scripts/daily-report.mjs (no --post — rebuild the cache only, like the
// daily-report-refresh builtin), inheriting env so gh auth/DEV_SOCIETY_REPO apply.
// Injectable via createDashboardServer({ regenerateDaily }) so tests stub it.
// Resolves on exit 0; rejects on non-zero, spawn error, or a 120s timeout.
// Parse an owner/repo slug from a git remote URL (https or ssh form), or '' if none.
// daily-report.mjs requires DEV_SOCIETY_REPO; a manually-launched dashboard won't have
// it in env (only the launchd daemon pins it), so we derive it from the repo's remote.
export function repoSlugFromRemote(url) {
  const m = String(url || '').trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : '';
}

function defaultRegenerateDaily(meshRoot) {
  const repoRoot = resolve(meshRoot, '..');
  const script = join(repoRoot, 'scripts', 'daily-report.mjs');
  const env = { ...process.env };
  if (!env.DEV_SOCIETY_REPO) {
    try {
      const url = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
      const slug = repoSlugFromRemote(url);
      if (slug) env.DEV_SOCIETY_REPO = slug;
    } catch { /* no git/remote — daily-report.mjs will report the missing repo itself */ }
  }
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script], { cwd: repoRoot, stdio: 'ignore', env });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } rej(new Error('daily-report timed out')); }, 120000);
    child.on('error', (e) => { clearTimeout(timer); rej(e); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? res() : rej(new Error(`daily-report exited ${code}`)); });
  });
}

// Text MIME types: we serve these as text; everything else → metadata stub
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.py', '.sh', '.bash', '.zsh', '.fish', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.env.example', '.gitignore',
  '.dockerignore', '.html', '.css', '.xml', '.csv', '.log', '.sql',
  '.rs', '.go', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.hpp',
  '.swift', '.kt', '.kts', '.scala', '.r', '.m', '.mts', '.cts'
]);

function isTextFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  // No extension → likely a text file (Makefile, Dockerfile, etc.)
  if (!ext) return true;
  return TEXT_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Security headers applied to every response
// ---------------------------------------------------------------------------

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Scripts stay locked to 'self' (no 'unsafe-inline' for scripts → XSS boundary
  // intact; all JS is in external CSP-safe files). Styles need 'unsafe-inline'
  // because the app sets dynamic inline styles (pane resize widths, graph tooltip
  // positioning) and pulls the webfont CSS from Google Fonts; without this the
  // browser console filled with CSP violations and resize/tooltip styling was
  // dropped. Inline styles cannot execute script, and rendered HTML is sanitized
  // by render-core, so this does not widen the XSS surface.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com"
  );
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = val;
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Same-origin gate
// ---------------------------------------------------------------------------

/**
 * Enforce same-origin policy:
 *  - parsed Host authority hostname ∈ {127.0.0.1, localhost}
 *  - Host port matches listener port
 *  - Sec-Fetch-Site: same-origin|none  OR  Origin matches listener origin
 *
 * Returns true if the request passes; false (should reject) otherwise.
 *
 * @param {object} req    IncomingMessage
 * @param {number} listenerPort
 * @returns {boolean}
 */
/**
 * Is `hostName` an accepted remote (proxied) host? Either a *.ts.net MagicDNS name
 * (Tailscale serve — tailnet membership + token are the gate) or an explicitly
 * allowlisted hostname. Never a wildcard; localhost/127.0.0.1 are handled separately.
 */
function isAllowedRemoteHost(hostName, allowedHosts) {
  const h = hostName.toLowerCase();
  if (h.endsWith('.ts.net')) return true;
  return allowedHosts.includes(h);
}

function passesSameOriginGate(req, listenerPort, allowedHosts = []) {
  const hostHeader = req.headers['host'] ?? '';
  const portStr = String(listenerPort);

  // Parse host header: host[:port]
  let hostName, hostPort;
  const bracketMatch = hostHeader.match(/^\[(.+)\]:?(\d*)$/);
  if (bracketMatch) {
    hostName = bracketMatch[1];
    hostPort = bracketMatch[2] || String(listenerPort);
  } else {
    const parts = hostHeader.split(':');
    hostName = parts[0];
    hostPort = parts[1] ?? portStr;
  }

  const isLocal = hostName === '127.0.0.1' || hostName === 'localhost';
  const isRemote = !isLocal && isAllowedRemoteHost(hostName, allowedHosts);

  // Hostname must be a known local host or an allowlisted remote (proxied) host.
  if (!isLocal && !isRemote) return false;

  // Local hosts must match the listener port exactly. Allowlisted remote hosts are
  // reached through a TLS proxy (Tailscale serve on 443), so the Host carries no
  // port or :443 — accept that, but still reject a mismatched explicit port.
  if (isLocal) {
    if (hostPort !== portStr) return false;
  } else {
    const noColon = !hostHeader.includes(':') || bracketMatch && !bracketMatch[2];
    if (!(noColon || hostPort === '443' || hostPort === portStr)) return false;
  }

  // Check Sec-Fetch-Site
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'same-origin' || sfs === 'none') return true;

  // Check Origin header as fallback (for browsers that don't send Sec-Fetch-Site)
  const origin = req.headers['origin'];
  if (origin) {
    if (isRemote) {
      // Same-origin under the proxy: https on the MagicDNS/allowlisted host.
      if (origin === `https://${hostName}` || origin === `https://${hostName}:${hostPort}`) return true;
      return false;
    }
    const expectedOrigin = `http://127.0.0.1:${listenerPort}`;
    const expectedOriginLocal = `http://localhost:${listenerPort}`;
    if (origin === expectedOrigin || origin === expectedOriginLocal) return true;
    return false;
  }

  // No Sec-Fetch-Site and no Origin: allow (e.g. top-level nav, curl)
  return true;
}

// ---------------------------------------------------------------------------
// Token comparison (timing-safe)
// ---------------------------------------------------------------------------

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Snapshot loading (I/O)
// ---------------------------------------------------------------------------

async function loadDashboardSnapshot(meshRoot) {
  // Read manifest
  let manifest = null;
  try {
    manifest = await readManifest(meshRoot);
  } catch {
    manifest = null;
  }

  // Build global skills list from mesh/skills/
  const globalSkills = [];
  const meshSkillsDir = join(meshRoot, 'mesh', 'skills');
  try {
    const entries = await readdir(meshSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(meshSkillsDir, entry.name, 'SKILL.md');
      try {
        const summary = await extractSkillSummary(skillPath);
        globalSkills.push({ name: entry.name, summary });
      } catch { /* skip */ }
    }
  } catch { /* no mesh/skills dir */ }

  // Global MCP from mesh/mcp.json
  const globalMcps = [];
  const meshMcpPath = join(meshRoot, 'mesh', 'mcp.json');
  try {
    const raw = JSON.parse(await readFile(meshMcpPath, 'utf8'));
    const servers = raw.mcpServers ?? {};
    for (const [name, config] of Object.entries(servers)) {
      globalMcps.push({ name, config });
    }
  } catch { /* no global mcp */ }

  // Per-agent data
  const agentSkills = new Map();
  const agentMcps = new Map();
  const filesByAgent = new Map();
  const descriptionsByAgent = new Map();
  const meshFilesList = [];

  const agents = manifest?.agents ?? [];

  for (const agentEntry of agents) {
    const agentRoot = join(meshRoot, agentEntry.root);

    // Agent identity: agent.json description (the A2A card text) so the board
    // can show WHAT each agent is. Missing/corrupt file degrades to ''.
    let description = '';
    try {
      const agentJson = JSON.parse(await readFile(join(agentRoot, 'agent.json'), 'utf8'));
      if (agentJson && typeof agentJson.description === 'string') description = agentJson.description;
    } catch { /* missing/corrupt agent.json → '' */ }
    descriptionsByAgent.set(agentEntry.name, description);

    // Per-agent skills — discovered across all skill-root conventions
    // (skills/, .claude/skills/, .agent/skills/) so a converted agent's existing
    // skills surface here, matching what the worker runtime sees.
    const aSkills = [];
    for (const skill of await listLocalSkills(agentRoot)) {
      try {
        const summary = await extractSkillSummary(skill.path);
        aSkills.push({ name: skill.name, summary });
      } catch { /* skip */ }
    }
    agentSkills.set(agentEntry.name, aSkills);

    // Per-agent MCPs
    const agentMcpPath = join(agentRoot, '.mcp.json');
    const aMcps = [];
    try {
      const raw = JSON.parse(await readFile(agentMcpPath, 'utf8'));
      const servers = raw.mcpServers ?? {};
      for (const [name, config] of Object.entries(servers)) {
        aMcps.push({ name, config });
      }
    } catch { /* no .mcp.json */ }
    agentMcps.set(agentEntry.name, aMcps);

    // Per-agent file tree
    const aFiles = [];
    await collectFiles(agentRoot, agentRoot, aFiles);
    filesByAgent.set(agentEntry.name, aFiles);
  }

  // Mesh-level file tree
  await collectFiles(meshRoot, meshRoot, meshFilesList);

  return {
    manifest,
    globalSkills,
    globalMcps,
    agentSkills,
    agentMcps,
    filesByAgent,
    descriptionsByAgent,
    meshFiles: meshFilesList,
    conformanceByAgent: new Map()
  };
}

/**
 * Recursively collect relative paths under `root` starting from `dir`.
 * Skips sensitive paths.
 *
 * @param {string} baseRoot  root for relative path calculation
 * @param {string} dir       current directory
 * @param {string[]} result  output array
 */
// Bound the explorer walk so a huge agent folder (e.g. a 50k-file vault copied
// into the mesh) cannot make /api/tree allocate and serialize an unbounded list
// or lag the browser rendering it. Past the cap we stop descending; the explorer
// shows a representative prefix rather than every file.
const MAX_TREE_ENTRIES = 4000;
const MAX_TREE_DEPTH = 12;

async function collectFiles(baseRoot, dir, result, depth = 0) {
  if (result.length >= MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (result.length >= MAX_TREE_ENTRIES) return;
    const absPath = join(dir, entry.name);
    const relPath = relative(baseRoot, absPath);
    if (isSensitivePath(relPath)) continue;
    if (entry.isDirectory()) {
      result.push(relPath + '/');
      await collectFiles(baseRoot, absPath, result, depth + 1);
    } else if (entry.isFile()) {
      result.push(relPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Activity snapshot (I/O): read recent run logs across agents → buildActivity.
// Only the redacted view-model leaves this function (no log_path/stdout/stderr).
// ---------------------------------------------------------------------------

const ACTIVITY_DATE_FILES = 3;       // most recent date files to scan per agent
const ACTIVITY_RUNS_PER_AGENT = 25;  // most recent runs per agent to surface

// Per-agent activity-stats endpoint caps (Phase 4 — Activity tab work report).
const ACTIVITY_STATS_MAX_FILES = 31;                      // run-log date files per prefix
const ACTIVITY_STATS_MAX_TRANSCRIPTS = 10;                // newest transcripts scanned for tool_use
const ACTIVITY_STATS_TRANSCRIPT_BYTES = 2 * 1024 * 1024;  // tail cap per transcript

// /api/usage cache: the per-agent transcript scan is heavy (≤10×2MB per
// agent), and the board refreshes every 30s — cache per mesh, short TTL.
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const usageCaches = new Map();   // meshRoot → { at, payload }

// Collaboration endpoint caps (Phase 8 — /api/collab).
const COLLAB_MAX_DAYS = 90;        // ?days= upper bound
const COLLAB_MAX_FILES = 31;       // a2a-*.jsonl date files scanned per agent
const COLLAB_TOPICS_PER_EDGE = 5;  // newest topic snippets per directed edge
const COLLAB_TOPIC_CHARS = 100;    // topic text truncation

async function loadActivitySnapshot(meshRoot) {
  let manifest = null;
  try { manifest = await readManifest(meshRoot); } catch { manifest = null; }
  const agents = manifest?.agents ?? [];
  const records = [];
  for (const agent of agents) {
    const logDir = join(meshRoot, agent.root, '.agent-mesh', 'logs');
    let files = [];
    try { files = await readdir(logDir); } catch { continue; }
    // Grouped per-date files (delegate-YYYY-MM-DD.jsonl) — newest dates last; also
    // tolerate any legacy per-run delegate-*.json. Exclude path-guard-denials.jsonl.
    // The recency cap is applied PER PREFIX: a combined lexicographic sort would
    // put every a2a-* file before every delegate-* file ('a' < 'd'), starving a2a
    // logs out of the slice once an agent has ≥ ACTIVITY_DATE_FILES delegate files.
    const isLogFile = (f) => f.endsWith('.jsonl') || f.endsWith('.json');
    const lastN = (prefix) => files
      .filter((f) => f.startsWith(prefix) && isLogFile(f))
      .sort()
      .slice(-ACTIVITY_DATE_FILES);
    const logFiles = [...lastN('delegate-'), ...lastN('a2a-')];
    let agentRecords = [];
    for (const f of logFiles) {
      const recs = await readRunLogRecords(join(logDir, f));
      for (const r of recs) agentRecords.push(r);
    }
    // Collapse start+final per run id, keep the most recent runs.
    agentRecords = dedupeRunRecords(agentRecords)
      .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')))
      .slice(-ACTIVITY_RUNS_PER_AGENT);
    for (const r of agentRecords) records.push({ ...r, agent: agent.name });
  }

  // Append GitHub-Actions activity (written by the orchestrator's gh-activity-poll
  // builtin). Records are pre-shaped to buildActivity's contract; keep agent/from/to
  // as-is (do NOT re-tag like per-agent logs). Missing/corrupt cache → local-only.
  const ghActivityPath = process.env.AGENT_MESH_GH_ACTIVITY
    || resolve(meshRoot, '..', '.dev-society', 'gh-activity.json');
  try {
    const gh = JSON.parse(await readFile(ghActivityPath, 'utf8'));
    if (Array.isArray(gh)) for (const r of gh) records.push(r);
  } catch { /* no cache / unreadable → local activity only */ }

  return buildActivity(records);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json)
  });
  res.end(json);
}

function sendText(res, status, text, contentType = 'text/plain') {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length
  });
  res.end(buf);
}

function send403(res, reason = 'Forbidden') {
  applySecurityHeaders(res);
  sendText(res, 403, reason);
}

function send404(res) {
  applySecurityHeaders(res);
  sendText(res, 404, 'Not Found');
}

/**
 * Read a request body up to `cap` bytes. Resolves with the UTF-8 string, or
 * rejects with an Error tagged `.tooLarge` if the cap is exceeded (the caller
 * maps that to 413). Aborts cleanly on a destroyed/aborted request.
 *
 * @param {object} req  IncomingMessage
 * @param {number} cap  max bytes
 * @returns {Promise<string>}
 */
function readBodyCapped(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > cap) {
        settled = true;
        const err = new Error('request body too large');
        err.tooLarge = true;
        // Stop reading but leave the socket intact so the route can still send
        // a 413 response; destroying req here would reset the connection.
        req.pause();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

// Map a ConsoleError code → HTTP status. Domain rejections (the agent/mesh said
// "no") return 200 with { ok:false, error } so the canvas renders them uniformly;
// malformed input is a 4xx; everything else is a 5xx.
function consoleErrorStatus(code) {
  switch (code) {
    case 'mode_disabled':
    case 'not_served':
    case 'stale_registry':
      return 200;
    case 'bad_input':
      return 400;
    case 'aborted':
      return 499; // client closed request
    default:
      return 502; // spawn_failed / internal
  }
}

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

async function handleRequest(req, res, { meshRoot, token, listenerPort, allowedHosts = [], concierge, consoleBroker, chatEnabled, sse, shellLauncher, sessionRunner, sessionIndex, sessionMirror, sessionLive, sessionLogEnabled, fetchImage, mirrorStreams, rotationManager, spawnLocate, scheduler, dailyReportPath, dailyReportDir, dailyRefresh, dashboardOwnsScheduler }) {
  applySecurityHeaders(res);

  const url = new URL(req.url ?? '/', `http://127.0.0.1:${listenerPort}`);
  const pathname = url.pathname;

  // -----------------------------------------------------------------------
  // Bootstrap route: GET /?t=<token>  (and /m?t=<token> for the mobile PWA)
  // -----------------------------------------------------------------------
  if ((pathname === '/' || pathname === '/m') && req.method === 'GET' && url.searchParams.has('t')) {
    const candidate = url.searchParams.get('t');
    if (!tokenEquals(candidate, token)) {
      send403(res, 'Invalid token');
      return;
    }
    // When reached through an HTTPS proxy (Tailscale serve sets X-Forwarded-Proto),
    // mark the cookie Secure so it is only ever returned over TLS.
    const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
    // SameSite=Lax (not Strict): Strict cookies set during a redirect are dropped
    // by some mobile browsers (iOS Safari), which then 403'd the page's own JS/CSS
    // subrequests → "opens but won't fully load". Lax is sent on top-level nav +
    // same-site subresources, which is exactly this same-origin PWA.
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${token}; SameSite=Lax; HttpOnly;${secure} Path=/`
    );
    // Desktop board ('/'): redirect to the clean URL (drops the token from the bar).
    // Mobile ('/m'): serve the page DIRECTLY on this same 200 response so the cookie
    // is present before the browser fetches /mobile/*.js|css — no fragile redirect
    // hop where the cookie can be lost. Fall through to the static-serve block.
    if (pathname === '/') {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    // /m: fall through (cookie already set on res); same-origin gate below still
    // applies, and the static shell is public so it serves without a cookie.
  }

  // -----------------------------------------------------------------------
  // All other routes: require same-origin gate; cookie required EXCEPT for the
  // public mobile UI shell (static HTML/CSS/JS — no data). Every /api/* data and
  // action route still requires the token, so auth is never weakened.
  // -----------------------------------------------------------------------

  // Same-origin gate (applies to everything, including the public shell)
  if (!passesSameOriginGate(req, listenerPort, allowedHosts)) {
    send403(res, 'Cross-origin request denied');
    return;
  }

  // The mobile PWA shell is non-sensitive UI code; serving it without the token
  // means the page always renders, and a cookie hiccup degrades to "data needs
  // sign-in" instead of a blank/403 page. Data + actions stay gated below.
  const isPublicShell = pathname === '/m' || pathname.startsWith('/mobile/');

  // Token auth (skipped only for the public shell). Accept the token via the cookie
  // OR an `X-Dashboard-Token` header — the header is a cookie-independent fallback
  // for mobile browsers that drop the cookie; the mobile PWA captures `?t=` once and
  // sends it as this header on every /api call. Same token, same strength.
  if (!isPublicShell) {
    const cookies = parseCookies(req.headers['cookie']);
    const cookieVal = cookies[COOKIE_NAME] ?? '';
    const headerVal = req.headers['x-dashboard-token'] ?? '';
    if (!tokenEquals(cookieVal, token) && !tokenEquals(headerVal, token)) {
      send403(res, 'Authentication required');
      return;
    }
  }

  // -----------------------------------------------------------------------
  // API routes
  // -----------------------------------------------------------------------

  if (pathname === '/api/mesh' && req.method === 'GET') {
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const view = meshView(snapshot);
    view.shellEnabled = !!shellLauncher;       // gate the native-CLI button in the UI
    view.sessionLogEnabled = sessionLogEnabled; // gate the session-log view (list/transcript)
    view.chatEnabled = !!chatEnabled;           // gate the in-dashboard chat composer (off by default)
    sendJson(res, 200, view);
    return;
  }

  // GET /api/daily → the latest cached Daily Mesh Report model (mesh-wide
  // PR/Issue/Token digest), written by scripts/daily-report.mjs each run. A
  // read-only file read — never shells gh on page load. `{ available:false }`
  // when no report has been generated yet (so the tab shows an empty state).
  if (pathname === '/api/daily' && req.method === 'GET') {
    const cachePath = dailyReportPath
      || process.env.AGENT_MESH_DAILY_REPORT_CACHE
      || resolve(meshRoot, '..', '.dev-society', 'daily-report.json');
    try {
      const report = JSON.parse(readFileSync(cachePath, 'utf8'));
      sendJson(res, 200, { available: true, report });
    } catch {
      sendJson(res, 200, { available: false });
    }
    return;
  }

  // POST /api/daily/refresh → regenerate the Daily Mesh Report cache on demand
  // (runs daily-report.mjs via the injectable regenerator), then return the fresh
  // report — the manual ↻ + periodic auto-refresh behind the Token/Issues/PR panels,
  // which otherwise only update on the daily schedule. Concurrent requests coalesce
  // onto one in-flight regeneration (dailyRefresh.inflight).
  if (pathname === '/api/daily/refresh' && req.method === 'POST') {
    try {
      if (!dailyRefresh.inflight) {
        dailyRefresh.inflight = Promise.resolve(dailyRefresh.fn(meshRoot)).finally(() => { dailyRefresh.inflight = null; });
      }
      await dailyRefresh.inflight;
    } catch (err) {
      sendJson(res, 502, { ok: false, error: { code: 'refresh_failed', message: String(err && err.message || err) } });
      return;
    }
    const cachePath = dailyReportPath
      || process.env.AGENT_MESH_DAILY_REPORT_CACHE
      || resolve(meshRoot, '..', '.dev-society', 'daily-report.json');
    try {
      const report = JSON.parse(readFileSync(cachePath, 'utf8'));
      sendJson(res, 200, { ok: true, available: true, report });
    } catch {
      sendJson(res, 200, { ok: true, available: false });
    }
    return;
  }

  // GET /api/tokens?range=today|week|month → the token-consumption panel model,
  // aggregated from the per-date daily-report caches. today = the latest report;
  // week/month = sum the last 7/30 dated caches (missing days skipped).
  if (pathname === '/api/tokens' && req.method === 'GET') {
    const range = url.searchParams.get('range') || 'today';
    const dir = dailyReportDir || process.env.AGENT_MESH_DAILY_REPORT_DIR
      || resolve(meshRoot, '..', '.dev-society');
    const latest = dailyReportPath || join(dir, 'daily-report.json');
    const models = [];
    if (range === 'today') {
      try { models.push(JSON.parse(readFileSync(latest, 'utf8'))); } catch { /* none yet */ }
    } else {
      const n = range === 'month' ? 30 : 7;
      const nowMs = Date.now();
      for (let i = n - 1; i >= 0; i--) {
        const date = new Date(nowMs - i * 86400000).toISOString().slice(0, 10);
        try { models.push(JSON.parse(readFileSync(join(dir, `daily-report-${date}.json`), 'utf8'))); } catch { /* skip missing day */ }
      }
    }
    sendJson(res, 200, { range, model: aggregateRange(models) });
    return;
  }

  // GET /api/schedules → mesh-wide read-only view of every agent's scheduled
  // jobs (defs + runtime state). The daemon owns execution; this is a window.
  if (pathname === '/api/schedules' && req.method === 'GET') {
    const { jobs } = await listAllSchedules({ meshRoot });
    const schedulerOwner = dashboardOwnsScheduler ? 'dashboard' : (jobs.length ? 'daemon' : 'none');
    sendJson(res, 200, { schedulerOwner, jobs });
    return;
  }

  // GET /api/merge-sweep → latest merge-sweep report (if any), with a staleness
  // flag computed against the report cadence. Read-only.
  if (pathname === '/api/merge-sweep' && req.method === 'GET') {
    return sendJson(res, 200, readMergeSweepApi(meshRoot, new Date()));
  }

  // GET /api/ci-schedules → read-only view of GitHub Actions cron workflows
  // (parsed from .github/workflows) enriched with last-run/status from the
  // gh-activity cache. No `gh` calls. Auth-gated by the upstream API gate.
  if (pathname === '/api/ci-schedules' && req.method === 'GET') {
    const wfDir = resolve(meshRoot, '..', '.github', 'workflows');
    let files;
    try {
      files = readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => ({ name: f, text: readFileSync(join(wfDir, f), 'utf8') }));
    } catch {
      sendJson(res, 200, { workflows: [] });   // no workflows dir → empty
      return;
    }
    const ghActivityPath = process.env.AGENT_MESH_GH_ACTIVITY
      || resolve(meshRoot, '..', '.dev-society', 'gh-activity.json');
    let ghActivity = [];
    try { const p = JSON.parse(readFileSync(ghActivityPath, 'utf8')); if (Array.isArray(p)) ghActivity = p; }
    catch { ghActivity = []; }                  // missing/corrupt cache → still parse files
    sendJson(res, 200, { workflows: listCiSchedules({ files, ghActivity }) });
    return;
  }

  // POST /api/schedules/run { agent, id } → 202 re-arms the job's nextRunAt to
  // now so the daemon's next tick (≤30 s) picks it up. Does NOT require a
  // dashboard-side scheduler. Validates: manifest entry (404), path safety
  // (403), job in defs (404), job enabled (409). Writes only schedule-state.json.
  if (pathname === '/api/schedules/run' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
    const name = String(body.agent || '');
    const id = String(body.id || '');
    if (!isSafeArtifactId(id)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id' } }); return; }
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find((a) => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }
    const defs = await readScheduleFile(agentRoot);
    const job = defs.jobs.find((j) => j && j.id === id);
    if (!job) { send404(res); return; }
    if (!job.enabled) { sendJson(res, 409, { ok: false, error: { code: 'disabled', message: 'enable the job to run it' } }); return; }
    const statePath = scheduleStatePath(agentRoot);
    let state = {};
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = {}; }
    const next = markJobDue(state, id, new Date());
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    if (scheduler) Promise.resolve(scheduler.runNow(name, id)).catch(() => { /* recorded in state */ });
    sendJson(res, 202, { ok: true, queued: true, runsWithinMs: 30000 });
    return;
  }

  // GET /api/health → the full Mesh "Vital Signs" model (passive): per-agent
  // liveness, five-organ status, activity history, and a rendered health report.
  // Backward-compatible: the old heartbeat keys (summary/findings/openEscalations)
  // stay at the top level + under organs.jobs, so the legacy Graph-view Health
  // panel keeps working. Never 500s — on total failure returns an unknown shell.
  // Spec: docs/superpowers/specs/2026-06-21-mesh-health-vitals-view-design.md
  if (pathname === '/api/health' && req.method === 'GET') {
    try {
      sendJson(res, 200, await collectHealth({ meshRoot, env: process.env, now: Date.now() }));
    } catch {
      sendJson(res, 200, {
        generatedAt: null, overall: 'unknown', organs: {}, agentVitals: [],
        activityHistory: { days: [], perAgent: {}, events: [] }, report: { markdown: '' },
        summary: { ok: 0, failing: 0, overdue: 0, stuck: 0, escalated: 0 }, findings: [], openEscalations: [],
      });
    }
    return;
  }

  // GET /api/activity-log → recent daemon activity events (newest-first), with
  // filter facets for dropdown population. Reads from .dev-society/activity-*.jsonl.
  // Tolerant: missing dir → empty 200, never 500. Override dir via env var.
  if (pathname === '/api/activity-log' && req.method === 'GET') {
    const dir = process.env.AGENT_MESH_ACTIVITY_DIR || resolve(meshRoot, '..', '.dev-society');
    const base = readActivity({ dir, since: url.searchParams.get('since') || undefined, limit: 500 });
    const agents = [...new Set(base.map((e) => e.agent).filter(Boolean))].sort();
    const types = [...new Set(base.map((e) => e.type).filter(Boolean))].sort();
    const events = filterEvents(base, {
      agent: url.searchParams.get('agent') || undefined,
      type: url.searchParams.get('type') || undefined,
      level: url.searchParams.get('level') || undefined,
    }).slice(0, Number(url.searchParams.get('limit')) || 200);
    sendJson(res, 200, { events, agents, types });
    return;
  }

  // GET /api/resources → mesh + per-agent grouped skills/MCP for the board's
  // "resources" view. The frontend (app.js) fetches this; the route was missing
  // (resourcesView was imported but never wired), so the board 404'd.
  if (pathname === '/api/resources' && req.method === 'GET') {
    const snapshot = await loadDashboardSnapshot(meshRoot);
    sendJson(res, 200, resourcesView(snapshot));
    return;
  }

  // GET /api/agent/:name/worklog → { exists, path, content } for that agent's
  // WORK_LOG.md (a per-agent maintenance log distilled from sessions: why
  // decisions were made, blockers, next steps — the curated companion to the
  // raw session transcript). Missing file is 200 { exists:false } so the
  // frontend can show a "create one" empty state without a 404 round-trip.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/worklog') && req.method === 'GET') {
    const inner = pathname.slice('/api/agent/'.length, -'/worklog'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    const wlPath = join(agentRoot, 'WORK_LOG.md');
    try {
      const content = await readFile(wlPath, 'utf8');
      sendJson(res, 200, { exists: true, path: wlPath, content });
    } catch {
      sendJson(res, 200, { exists: false, path: wlPath, content: '' });
    }
    return;
  }

  // GET /api/agent/:name/deliverables → flat recursive listing of the agent's
  // deliverables/ tree: { entries:[{ path, size, mtime }] } (paths relative to
  // deliverables/, forward-slash). Sensitive names filtered. Missing dir → [].
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/deliverables') && req.method === 'GET') {
    const inner = pathname.slice('/api/agent/'.length, -'/deliverables'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    const base = join(agentRoot, 'deliverables');
    const entries = [];
    async function walk(dir, rel) {
      let items;
      try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const childRel = rel ? `${rel}/${it.name}` : it.name;
        if (isSensitivePath(childRel)) continue;
        if (it.isDirectory()) {
          await walk(join(dir, it.name), childRel);
        } else {
          const st = await stat(join(dir, it.name)).catch(() => null);
          if (st) entries.push({ path: childRel, size: st.size, mtime: st.mtime.toISOString() });
        }
      }
    }
    await walk(base, '');
    sendJson(res, 200, { entries });
    return;
  }

  // GET /api/agent/:name/deliverable?path=<rel>[&download=1] → raw bytes of one
  // file from the agent's deliverables/ tree (preview/download for the Files
  // tab). MIME by extension; HTML carries `Content-Security-Policy: sandbox` so
  // the iframe preview cannot run scripts or reach the network. download=1 adds
  // an attachment disposition. Traversal/absolute/sensitive paths → 403.
  // Note: `endsWith('/deliverable')` (singular) is disjoint from the plural
  // listing route above, so neither shadows the other.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/deliverable') && req.method === 'GET') {
    const inner = pathname.slice('/api/agent/'.length, -'/deliverable'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    const rawPath = url.searchParams.get('path') ?? '';
    if (!rawPath || rawPath.includes('\0') || isAbsolute(rawPath)) {
      send403(res, 'Invalid deliverable path');
      return;
    }
    if (isSensitivePath(rawPath)) { send403(res, 'Sensitive path denied'); return; }

    const base = join(agentRoot, 'deliverables');
    const candidate = resolve(base, rawPath);
    const contained = await isPathInsideRoot(base, candidate).catch(() => false);
    if (!contained) { send403(res, 'Path outside deliverables'); return; }

    let content;
    try {
      content = await readFile(candidate); // Buffer — fine for text and binary alike
    } catch {
      send404(res);
      return;
    }

    const ext = extname(candidate).toLowerCase();
    const mime = DELIVERABLE_MIME[ext] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime,
      'Content-Length': content.length,
      'Cache-Control': 'no-store, must-revalidate'
    };
    if (ext === '.html') headers['Content-Security-Policy'] = 'sandbox';
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${basename(candidate).replace(/"/g, '')}"`;
    }
    res.writeHead(200, headers);
    res.end(content);
    return;
  }

  // POST /api/agent/:name/deliverable/locate — open Windows File Explorer with
  // the deliverable selected (JSON body { path }, relative to deliverables/).
  // PRIVILEGED: requires the shell launcher — the exact gate that sets
  // `shellEnabled` on /api/mesh — and is checked FIRST, before any lookups.
  // Same name/containment/sensitive checks as the read route; file must exist
  // (→ 404 otherwise). Spawn goes through `spawnLocate` (injectable for tests);
  // the default uses an argv array, never a shell string.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/deliverable/locate') && req.method === 'POST') {
    if (!shellLauncher) { send403(res, 'shell_disabled'); return; }

    const inner = pathname.slice('/api/agent/'.length, -'/deliverable/locate'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    let body;
    try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }

    const rawPath = typeof body.path === 'string' ? body.path : '';
    if (!rawPath || rawPath.includes('\0') || isAbsolute(rawPath)) {
      send403(res, 'Invalid deliverable path');
      return;
    }
    if (isSensitivePath(rawPath)) { send403(res, 'Sensitive path denied'); return; }

    const base = join(agentRoot, 'deliverables');
    const candidate = resolve(base, rawPath);
    const contained = await isPathInsideRoot(base, candidate).catch(() => false);
    if (!contained) { send403(res, 'Path outside deliverables'); return; }

    const st = await stat(candidate).catch(() => null);
    if (!st || !st.isFile()) { send404(res); return; }

    spawnLocate(candidate);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/agent/:name/artifacts — save a result plus its task context into
  // <agentRoot>/.agent/artifacts/<id>/{artifact.md,context.json} (spec §3.5,
  // Phase-3 storage contract). id = YYYY-MM-DD-HHMM-<slug>, suffixed -2/-3… on
  // collision. artifact.md = `# <title>` + provenance line + embedded content
  // (text sources ≤64KB) or a pointer line (file sources). These writes are
  // server-side state under agentRoot/.agent — not the deliverables tree — so
  // isSensitivePath does not apply here.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/artifacts') && req.method === 'POST') {
    const inner = pathname.slice('/api/agent/'.length, -'/artifacts'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    let body;
    try { body = JSON.parse((await readBodyCapped(req, ARTIFACT_BODY_CAP)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) { sendJson(res, 400, { ok: false, error: { code: 'missing_title' } }); return; }
    if (!ARTIFACT_TYPES.has(body.type)) { sendJson(res, 400, { ok: false, error: { code: 'bad_type' } }); return; }

    // Source: { kind:'text', content } or { kind:'file', path } (relative,
    // forward-slash, no NUL/absolute — it is recorded and pointed at, never
    // resolved server-side). Anything else → 400.
    const rawSource = body.source && typeof body.source === 'object' ? body.source : null;
    let source;
    if (rawSource?.kind === 'text' && typeof rawSource.content === 'string') {
      source = { kind: 'text', content: rawSource.content };
    } else if (rawSource?.kind === 'file' && typeof rawSource.path === 'string'
               && rawSource.path && !rawSource.path.includes('\0') && !isAbsolute(rawSource.path)) {
      source = { kind: 'file', path: rawSource.path.replace(/\\/g, '/') };
    } else {
      sendJson(res, 400, { ok: false, error: { code: 'bad_source' } });
      return;
    }

    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const baseId = `${stamp}-${artifactSlug(title) || 'artifact'}`;

    const artifactsRoot = join(agentRoot, '.agent', 'artifacts');
    let id = baseId;
    for (let n = 2; ; n += 1) {
      const exists = await stat(join(artifactsRoot, id)).then(() => true, () => false);
      if (!exists) break;
      id = `${baseId}-${n}`;
    }

    // Invariant: id is safe by construction (digit-leading stamp + [a-z0-9-]
    // slug) — double-check the pattern and the final path containment anyway.
    if (!ARTIFACT_ID_RE.test(id)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id' } }); return; }
    const dir = join(artifactsRoot, id);
    const contained = await isPathInsideRoot(agentRoot, dir).catch(() => false);
    if (!contained) { send403(res, 'Path outside artifacts'); return; }

    const context = {
      title,
      type: body.type,
      task: typeof body.task === 'string' ? body.task : '',
      inputs: Array.isArray(body.inputs) ? body.inputs.filter((i) => typeof i === 'string') : [],
      frame: Array.isArray(body.frame) ? body.frame.filter((s) => typeof s === 'string') : [],
      source,
      agent: name,
      savedAt: now.toISOString(),
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      promotedTo: null
    };

    const provenance = `> saved ${context.savedAt} · agent: ${name} · type: ${context.type}`
      + (context.task ? ` · task: ${context.task}` : '');
    let mdBody;
    if (source.kind === 'file') {
      mdBody = `Source file: deliverables/${source.path}`;
    } else if (Buffer.byteLength(source.content, 'utf8') <= ARTIFACT_TEXT_EMBED_CAP) {
      mdBody = source.content;
    } else {
      mdBody = '(content exceeds the 64KB embed threshold — full text in context.json)';
    }

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'context.json'), JSON.stringify(context, null, 2) + '\n', 'utf8');
      await writeFile(join(dir, 'artifact.md'), `# ${title}\n\n${provenance}\n\n${mdBody}\n`, 'utf8');
    } catch {
      sendJson(res, 500, { ok: false, error: { code: 'write_failed' } });
      return;
    }

    sendJson(res, 201, { ok: true, id });
    return;
  }

  // GET /api/agent/:name/artifacts → { artifacts:[…] } newest-first by savedAt.
  // Each row: { id, title, type, task, savedAt, promotedTo, source }. Entries
  // whose context.json is missing/unparseable are skipped; missing dir → [].
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/artifacts') && req.method === 'GET') {
    const inner = pathname.slice('/api/agent/'.length, -'/artifacts'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    const artifactsRoot = join(agentRoot, '.agent', 'artifacts');
    let items = [];
    try { items = await readdir(artifactsRoot, { withFileTypes: true }); } catch { /* missing dir → [] */ }

    const artifacts = [];
    for (const it of items) {
      if (!it.isDirectory() || !ARTIFACT_ID_RE.test(it.name)) continue;
      let ctx;
      try { ctx = JSON.parse(await readFile(join(artifactsRoot, it.name, 'context.json'), 'utf8')); } catch { continue; }
      if (!ctx || typeof ctx !== 'object') continue;
      artifacts.push({
        id: it.name,
        title: typeof ctx.title === 'string' ? ctx.title : '',
        type: typeof ctx.type === 'string' ? ctx.type : '',
        task: typeof ctx.task === 'string' ? ctx.task : '',
        savedAt: typeof ctx.savedAt === 'string' ? ctx.savedAt : '',
        promotedTo: ctx.promotedTo ?? null,
        source: ctx.source ?? null,
        // promote-form prefill: the captured decision context rides along
        inputs: Array.isArray(ctx.inputs) ? ctx.inputs.filter((x) => typeof x === 'string') : [],
        frame: Array.isArray(ctx.frame) ? ctx.frame.filter((x) => typeof x === 'string') : []
      });
    }
    artifacts.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    sendJson(res, 200, { artifacts });
    return;
  }

  // DELETE /api/agent/:name/artifact/:id → remove one saved artifact dir.
  // Refuses (403) to delete a dir that lacks context.json — only dirs this
  // feature created are deletable, never arbitrary folders under .agent/.
  {
    const m = req.method === 'DELETE' && pathname.match(/^\/api\/agent\/(.+?)\/artifact\/([^/]+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      if (!isSafeArtifactId(id)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id', message: 'artifact id has an unsafe shape' } }); return; }

      const snapshot = await loadDashboardSnapshot(meshRoot);
      const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
      if (!entry) { send404(res); return; }
      const agentRoot = resolve(join(meshRoot, entry.root));
      const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
      if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

      const dir = join(agentRoot, '.agent', 'artifacts', id);
      const dirStat = await stat(dir).catch(() => null);
      if (!dirStat?.isDirectory()) { send404(res); return; }
      const hasContext = await stat(join(dir, 'context.json')).then((s) => s.isFile(), () => false);
      if (!hasContext) { send403(res, 'not an artifact directory (no context.json)'); return; }

      await rm(dir, { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // POST /api/agent/:name/workflows → promote an artifact ({fromArtifact:id})
  // or create directly ({title, inputs?, frame?}). Writes the Phase-3 storage
  // contract: .agent/workflows/<slug>.md with frontmatter + '# Decision frame'.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/workflows') && req.method === 'POST') {
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -'/workflows'.length));
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    let body;
    try { body = JSON.parse(await readBodyCapped(req, ARTIFACT_BODY_CAP)); }
    catch (err) { sendJson(res, err?.statusCode === 413 ? 413 : 400, { ok: false, error: { code: 'bad_body', message: 'body must be JSON' } }); return; }

    const fromArtifact = typeof body?.fromArtifact === 'string' ? body.fromArtifact : null;
    // Explicit fields ALWAYS win — promotion is a manual authoring step (the
    // form prefills from the artifact but the user edits before creating).
    // fromArtifact supplies fallback values and the provenance linkage only.
    let title = typeof body?.title === 'string' ? body.title.trim() : '';
    const purpose = typeof body?.purpose === 'string' ? body.purpose.trim().replace(/\s*\n\s*/g, ' ') : '';
    let inputs = Array.isArray(body?.inputs) ? body.inputs.filter((x) => typeof x === 'string') : null;
    let frame = Array.isArray(body?.frame) ? body.frame.filter((x) => typeof x === 'string') : null;
    let artifactCtxPath = null;
    let artifactCtx = null;

    if (fromArtifact !== null) {
      if (!isSafeArtifactId(fromArtifact)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id', message: 'fromArtifact id has an unsafe shape' } }); return; }
      artifactCtxPath = join(agentRoot, '.agent', 'artifacts', fromArtifact, 'context.json');
      try { artifactCtx = JSON.parse(await readFile(artifactCtxPath, 'utf8')); } catch { send404(res); return; }
      if (!title) title = typeof artifactCtx.title === 'string' ? artifactCtx.title : '';
      if (inputs === null) inputs = Array.isArray(artifactCtx.inputs) ? artifactCtx.inputs.filter((x) => typeof x === 'string') : [];
      if (frame === null) {
        frame = Array.isArray(artifactCtx.frame) && artifactCtx.frame.length > 0
          ? artifactCtx.frame.filter((x) => typeof x === 'string')
          : [typeof artifactCtx.task === 'string' ? artifactCtx.task : ''];
      }
    }
    inputs = inputs ?? [];
    frame = frame ?? [];
    if (!title) { sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: 'title or fromArtifact required' } }); return; }

    const wfRoot = join(agentRoot, '.agent', 'workflows');
    await mkdir(wfRoot, { recursive: true });
    const base = artifactSlug(title) || 'workflow';
    let slug = base;
    for (let n = 2; await stat(join(wfRoot, `${slug}.md`)).then(() => true, () => false); n++) {
      slug = `${base}-${n}`;
    }

    const created = new Date().toISOString().slice(0, 10);
    const md = [
      '---',
      `name: ${slug}`,
      `title: ${title}`,
      `purpose: ${purpose}`,
      `inputs: ${JSON.stringify(inputs)}`,
      `promoted_from: ${fromArtifact ?? ''}`,
      `created: ${created}`,
      '---',
      '# Decision frame',
      ...frame.map((s, i) => `${i + 1}. ${s}`),
      ''
    ].join('\n');
    await writeFile(join(wfRoot, `${slug}.md`), md, 'utf8');

    if (artifactCtx && artifactCtxPath) {
      try { await writeFile(artifactCtxPath, JSON.stringify({ ...artifactCtx, promotedTo: slug }, null, 2) + '\n', 'utf8'); }
      catch { /* promotion succeeded; linkage stamp is best-effort */ }
    }

    sendJson(res, 201, { ok: true, slug });
    return;
  }

  // GET /api/agent/:name/workflows → { workflows:[{slug,title,inputs,frame,
  // promoted_from,created}] } sorted created desc then slug asc. Files without
  // a frontmatter block (parseWorkflowMd → null) and non-.md files are skipped.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/workflows') && req.method === 'GET') {
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -'/workflows'.length));
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    const wfRoot = join(agentRoot, '.agent', 'workflows');
    let items = [];
    try { items = await readdir(wfRoot, { withFileTypes: true }); } catch { /* missing dir → [] */ }

    const workflows = [];
    for (const it of items) {
      if (!it.isFile() || !it.name.endsWith('.md')) continue;
      let parsed;
      try { parsed = parseWorkflowMd(await readFile(join(wfRoot, it.name), 'utf8')); } catch { continue; }
      // Skip agent-internal recipe files (not dashboard-managed): they lack
      // the name:+title: frontmatter keys and would render as blank cards.
      if (!parsed || !parsed.managed) continue;
      const { managed, ...row } = parsed;
      workflows.push({ slug: it.name.slice(0, -3), ...row });
    }
    workflows.sort((a, b) => b.created.localeCompare(a.created) || a.slug.localeCompare(b.slug));
    sendJson(res, 200, { workflows });
    return;
  }

  // DELETE /api/agent/:name/workflow/:slug → remove one workflow .md.
  {
    const m = req.method === 'DELETE' && pathname.match(/^\/api\/agent\/(.+?)\/workflow\/([^/]+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const slug = decodeURIComponent(m[2]);
      if (!isSafeArtifactId(slug)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id', message: 'workflow slug has an unsafe shape' } }); return; }

      const snapshot = await loadDashboardSnapshot(meshRoot);
      const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
      if (!entry) { send404(res); return; }
      const agentRoot = resolve(join(meshRoot, entry.root));
      const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
      if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

      const file = join(agentRoot, '.agent', 'workflows', `${slug}.md`);
      const fileStat = await stat(file).catch(() => null);
      if (!fileStat?.isFile()) { send404(res); return; }
      await unlink(file);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // GET /api/agent/:name/schedule → { schedulerEnabled, jobs:[def ⨯ state
  // merged, + cadenceLabel] } (Phase-5, spec §3.3). Works even when the
  // scheduler is off — defs are read directly with null state so the Schedule
  // tab can render read-only.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/schedule') && req.method === 'GET') {
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -'/schedule'.length));
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    let rows;
    if (scheduler) {
      rows = await scheduler.list(name);
    } else {
      const defs = await readScheduleFile(agentRoot);
      rows = defs.jobs
        .filter((j) => j && typeof j.id === 'string')
        .map((job) => ({
          id: job.id, name: job.name ?? job.id, prompt: job.prompt ?? '',
          cadence: job.cadence ?? null, enabled: !!job.enabled, saveArtifact: !!job.saveArtifact,
          lastRunAt: null, lastStatus: null, lastSummary: '', nextRunAt: null, running: false
        }));
    }
    const jobs = rows.map((row) => ({ ...row, cadenceLabel: row.cadence ? describeCadence(row.cadence) : '' }));
    sendJson(res, 200, { schedulerEnabled: !!scheduler, jobs });
    return;
  }

  // POST /api/agent/:name/schedule { name, prompt, cadence, saveArtifact? } →
  // 201 { id } — append a job definition to .agent/schedule.json. PRIVILEGED:
  // requires the scheduler (shell gate or injected), checked FIRST. id =
  // artifactSlug(name) with -2/-3… collision suffixes vs existing defs;
  // enabled defaults true, saveArtifact defaults false.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/schedule') && req.method === 'POST') {
    if (!scheduler) { sendJson(res, 403, { ok: false, error: { code: 'scheduler_disabled', message: 'scheduler is disabled; start the dashboard with --allow-shell' } }); return; }

    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -'/schedule'.length));
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    let body;
    try { body = JSON.parse((await readBodyCapped(req, ARTIFACT_BODY_CAP)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }

    const jobName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!jobName) { sendJson(res, 400, { ok: false, error: { code: 'missing_name', message: 'name must be a nonempty string' } }); return; }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) { sendJson(res, 400, { ok: false, error: { code: 'missing_prompt', message: 'prompt must be a nonempty string' } }); return; }
    const cadCheck = validateCadence(body.cadence);
    if (!cadCheck.ok) { sendJson(res, 400, { ok: false, error: { code: 'bad_cadence', message: cadCheck.message } }); return; }

    // Store the canonical cadence shape only (drop any extra body fields).
    const c = body.cadence;
    const cadence = c.kind === 'every' ? { kind: 'every', minutes: c.minutes }
      : c.kind === 'weekly' ? { kind: 'weekly', day: c.day, at: c.at }
      : { kind: 'daily', at: c.at };

    const defs = await readScheduleFile(agentRoot);
    const base = artifactSlug(jobName) || 'job';
    let id = base;
    for (let n = 2; defs.jobs.some((j) => j && j.id === id); n += 1) id = `${base}-${n}`;

    defs.jobs.push({ id, name: jobName, prompt, cadence, enabled: true, saveArtifact: !!body.saveArtifact });
    try { await writeScheduleFile(agentRoot, defs); }
    catch { sendJson(res, 500, { ok: false, error: { code: 'write_failed' } }); return; }

    sendJson(res, 201, { ok: true, id });
    return;
  }

  // POST /api/agent/:name/schedule/:id/run    → 202 (fires scheduler.runNow,
  //                                              NOT awaited)
  // POST /api/agent/:name/schedule/:id/enable → 200 ({enabled:bool} via
  //                                              scheduler.setEnabled)
  // Both PRIVILEGED (403 scheduler_disabled first), id shape-checked (400),
  // then agent (404) and job existence in defs (404).
  {
    const m = req.method === 'POST' && pathname.match(/^\/api\/agent\/(.+?)\/schedule\/([^/]+)\/(run|enable)$/);
    if (m) {
      if (!scheduler) { sendJson(res, 403, { ok: false, error: { code: 'scheduler_disabled', message: 'scheduler is disabled; start the dashboard with --allow-shell' } }); return; }

      const name = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      const action = m[3];
      if (!isSafeArtifactId(id)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id', message: 'job id has an unsafe shape' } }); return; }

      const snapshot = await loadDashboardSnapshot(meshRoot);
      const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
      if (!entry) { send404(res); return; }
      const agentRoot = resolve(join(meshRoot, entry.root));
      const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
      if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

      const defs = await readScheduleFile(agentRoot);
      if (!defs.jobs.some((j) => j && j.id === id)) { send404(res); return; }

      if (action === 'run') {
        // Fire and forget: a run is a full ask-mode delegation (minutes); the
        // tab polls the GET for the running → ok/fail transition instead.
        Promise.resolve(scheduler.runNow(name, id)).catch(() => { /* recorded in state */ });
        sendJson(res, 202, { ok: true });
        return;
      }

      let body;
      try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
      catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
      if (typeof body.enabled !== 'boolean') { sendJson(res, 400, { ok: false, error: { code: 'bad_enabled', message: 'enabled must be a boolean' } }); return; }

      await scheduler.setEnabled(name, id, body.enabled);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // DELETE /api/agent/:name/schedule/:id → remove the job definition from
  // .agent/schedule.json plus (best-effort) its runtime state entry.
  // PRIVILEGED (403 scheduler_disabled first).
  {
    const m = req.method === 'DELETE' && pathname.match(/^\/api\/agent\/(.+?)\/schedule\/([^/]+)$/);
    if (m) {
      if (!scheduler) { sendJson(res, 403, { ok: false, error: { code: 'scheduler_disabled', message: 'scheduler is disabled; start the dashboard with --allow-shell' } }); return; }

      const name = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      if (!isSafeArtifactId(id)) { sendJson(res, 400, { ok: false, error: { code: 'bad_id', message: 'job id has an unsafe shape' } }); return; }

      const snapshot = await loadDashboardSnapshot(meshRoot);
      const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
      if (!entry) { send404(res); return; }
      const agentRoot = resolve(join(meshRoot, entry.root));
      const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
      if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

      const defs = await readScheduleFile(agentRoot);
      const remaining = defs.jobs.filter((j) => !(j && j.id === id));
      if (remaining.length === defs.jobs.length) { send404(res); return; }
      try { await writeScheduleFile(agentRoot, { ...defs, jobs: remaining }); }
      catch { sendJson(res, 500, { ok: false, error: { code: 'write_failed' } }); return; }

      // Best-effort state prune — a stale entry is harmless (the scheduler
      // only acts on jobs present in defs), so failures are swallowed.
      try {
        const raw = JSON.parse(await readFile(scheduleStatePath(agentRoot), 'utf8'));
        if (raw && typeof raw === 'object' && id in raw) {
          delete raw[id];
          await writeFile(scheduleStatePath(agentRoot), JSON.stringify(raw, null, 2) + '\n', 'utf8');
        }
      } catch { /* best-effort */ }

      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // GET /api/agent/:name/activity-stats?range=today|week|month (default today)
  // → Activity-tab statistical work report (Phase 4): this agent's run-log
  // records (per-prefix filename selection like loadActivitySnapshot, but
  // date-suffix >= the range start, cap 31 files/prefix), artifact savedAt
  // rows, and — only when the session index is available — sessions plus a
  // bounded tool_use scan of the newest transcripts; all fed to the pure
  // buildActivityStats reducer. Optional sources degrade to null, never 500.
  // The response is the reducer output (route/peer/mode/firstPrompt summaries)
  // — same-auth surface as the transcript routes, so no redaction is applied.
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/activity-stats') && req.method === 'GET') {
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -'/activity-stats'.length));
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = snapshot?.manifest?.agents?.find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    const range = url.searchParams.get('range') ?? 'today';
    const now = new Date();
    let bounds;
    try { bounds = rangeBounds(range, now); }
    catch { sendJson(res, 400, { ok: false, error: { code: 'bad_range', message: 'range must be today, week or month' } }); return; }
    const f = bounds.from;
    const fromYmd = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;

    // Run records: files whose YYYY-MM-DD filename suffix is >= the range
    // start (lexicographic compare is chronological for zero-padded dates).
    const logDir = join(agentRoot, '.agent-mesh', 'logs');
    let files = [];
    try { files = await readdir(logDir); } catch { /* no logs yet → [] */ }
    const isLogFile = (fn) => fn.endsWith('.jsonl') || fn.endsWith('.json');
    const pick = (prefix) => files
      .filter((fn) => fn.startsWith(prefix) && isLogFile(fn))
      .filter((fn) => { const m = fn.slice(prefix.length).match(/^(\d{4}-\d{2}-\d{2})/); return m != null && m[1] >= fromYmd; })
      .sort()
      .slice(-ACTIVITY_STATS_MAX_FILES);
    let records = [];
    for (const fn of [...pick('delegate-'), ...pick('a2a-')]) {
      for (const r of await readRunLogRecords(join(logDir, fn))) records.push(r);
    }
    records = dedupeRunRecords(records);

    // Artifacts: savedAt/title per context.json (same read the artifacts GET does).
    const artifacts = [];
    try {
      const artifactsRoot = join(agentRoot, '.agent', 'artifacts');
      for (const it of await readdir(artifactsRoot, { withFileTypes: true })) {
        if (!it.isDirectory() || !ARTIFACT_ID_RE.test(it.name)) continue;
        try {
          const ctx = JSON.parse(await readFile(join(artifactsRoot, it.name, 'context.json'), 'utf8'));
          if (ctx && typeof ctx === 'object') artifacts.push({ savedAt: ctx.savedAt, title: typeof ctx.title === 'string' ? ctx.title : '' });
        } catch { /* unparseable entry skipped */ }
      }
    } catch { /* missing dir → [] */ }

    // Sessions + tool usage: only with the session index (--allow-shell).
    // Errors degrade to null (turns/toolCalls render as '—'), never 500.
    let sessions = null;
    let toolCounts = null;
    let toolUsageTruncated = false;
    if (sessionIndex) {
      try {
        const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
        sessions = await sessionIndex.listSessions(canonRoot);
      } catch { sessions = null; }
      if (Array.isArray(sessions)) {
        try {
          const scannable = sessions
            .filter((s) => s && typeof s.transcriptPath === 'string' && s.transcriptPath)
            .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
          if (scannable.length > ACTIVITY_STATS_MAX_TRANSCRIPTS) toolUsageTruncated = true;
          toolCounts = {};
          for (const s of scannable.slice(0, ACTIVITY_STATS_MAX_TRANSCRIPTS)) {
            let text;
            try {
              const st = await stat(s.transcriptPath);
              if (st.size > ACTIVITY_STATS_TRANSCRIPT_BYTES) {
                toolUsageTruncated = true;
                const fh = await open(s.transcriptPath, 'r');
                try {
                  const buf = Buffer.alloc(ACTIVITY_STATS_TRANSCRIPT_BYTES);
                  await fh.read(buf, 0, buf.length, st.size - buf.length);
                  text = buf.toString('utf8');
                } finally { await fh.close(); }
              } else {
                text = await readFile(s.transcriptPath, 'utf8');
              }
            } catch { continue; /* unreadable transcript skipped */ }
            for (const line of text.split('\n')) {
              const m = /"type":"tool_use".*?"name":"([^"]+)"/.exec(line);
              if (m) toolCounts[m[1]] = (toolCounts[m[1]] ?? 0) + 1;
            }
          }
        } catch { toolCounts = null; toolUsageTruncated = false; }
      }
    }

    sendJson(res, 200, buildActivityStats({ agent: name, records, sessions, artifacts, toolCounts, now, range, toolUsageTruncated }));
    return;
  }

  // GET /api/usage → per-agent skill/MCP invocation counts from recent
  // transcripts (the force graph sizes skill/MCP dots by usage — Obsidian
  // idiom). Skill calls appear as tool_use name:"Skill" with an input skill
  // name; MCP calls as mcp__<server>__<tool>. Transcript access is PRIVILEGED:
  // without the session backends this returns {available:false}. Results are
  // cached in-memory (TTL) — the scan reads up to 8×2MB per agent.
  if (pathname === '/api/usage' && req.method === 'GET') {
    if (!sessionIndex) { sendJson(res, 200, { available: false, agents: {} }); return; }
    const nowMs = Date.now();
    const cached = usageCaches.get(meshRoot);
    if (cached && nowMs - cached.at < USAGE_CACHE_TTL_MS) {
      sendJson(res, 200, cached.payload);
      return;
    }
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const out = {};
    for (const entry of snapshot?.manifest?.agents ?? []) {
      const agentRoot = resolve(join(meshRoot, entry.root));
      const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
      if (!inside) continue;
      const skills = {}, mcps = {};
      try {
        const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
        const sessions = (await sessionIndex.listSessions(canonRoot))
          .filter((s) => s.transcriptPath)
          .slice(0, ACTIVITY_STATS_MAX_TRANSCRIPTS);
        for (const s of sessions) {
          let text;
          try {
            const st = await stat(s.transcriptPath);
            if (st.size > ACTIVITY_STATS_TRANSCRIPT_BYTES) {
              const fh = await open(s.transcriptPath, 'r');
              try {
                const buf = Buffer.alloc(ACTIVITY_STATS_TRANSCRIPT_BYTES);
                await fh.read(buf, 0, buf.length, st.size - buf.length);
                text = buf.toString('utf8');
              } finally { await fh.close(); }
            } else {
              text = await readFile(s.transcriptPath, 'utf8');
            }
          } catch { continue; }
          for (const line of text.split('\n')) {
            const m = /"type":"tool_use".*?"name":"([^"]+)"/.exec(line);
            if (!m) continue;
            if (m[1] === 'Skill') {
              const sk = /"skill"\s*:\s*"([^"]+)"/.exec(line);
              if (sk) skills[sk[1]] = (skills[sk[1]] ?? 0) + 1;
            } else if (m[1].startsWith('mcp__')) {
              const server = m[1].split('__')[1];
              if (server) mcps[server] = (mcps[server] ?? 0) + 1;
            }
          }
        }
      } catch { /* agent unreadable → empty counts */ }
      out[entry.name] = { skills, mcps };
    }
    const payload = { available: true, agents: out };
    usageCaches.set(meshRoot, { at: nowMs, payload });
    sendJson(res, 200, payload);
    return;
  }

  if (pathname.startsWith('/api/agent/') && !pathname.includes('/session/') && req.method === 'GET') {
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length));
    if (!name) { send404(res); return; }

    const snapshot = await loadDashboardSnapshot(meshRoot);
    const agents = snapshot?.manifest?.agents ?? [];
    const entry = agents.find(a => a.name === name);
    if (!entry) { send404(res); return; }

    // Containment check
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) {
      send403(res, 'Agent root escapes mesh boundary');
      return;
    }

    const structure = await discoverAgentStructure(agentRoot, { meshRoot: join(meshRoot, 'mesh') });
    let agentJson = null;
    try {
      agentJson = JSON.parse(await readFile(join(agentRoot, 'agent.json'), 'utf8'));
    } catch { /* absent */ }
    const card = buildAgentCard({
      self: agentJson,
      root: agentRoot,
      url: `agent-mesh://${name}`,
      modes: entry.enabledModes
    });

    sendJson(res, 200, { name, entry, structure, card });
    return;
  }

  if (pathname === '/api/tree' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') ?? 'mesh';
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const tree = treeView(snapshot, scope);
    sendJson(res, 200, tree);
    return;
  }

  if (pathname === '/api/file' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path') ?? '';
    if (!rawPath) {
      send403(res, 'Missing path parameter');
      return;
    }
    const scope = url.searchParams.get('scope') ?? 'mesh';

    // Resolve relative paths against the scope's base:
    //   scope=mesh (or missing)        → meshRoot
    //   scope=<agent-name>             → meshRoot/<agent.root>  (from the manifest)
    //   absolute path                  → as-is (still validated below)
    // The frontend builds explorer paths relative to the current scope
    // (treeView in src/dashboard/data.js), so file fetches must anchor the
    // same way or they collapse to process.cwd() and 403 as "outside root".
    let base = meshRoot;
    if (!isAbsolute(rawPath) && scope !== 'mesh') {
      try {
        const snap = await loadDashboardSnapshot(meshRoot);
        const agent = snap?.manifest?.agents?.find((a) => a.name === scope);
        if (agent?.root) base = resolve(meshRoot, agent.root);
      } catch { /* fall back to meshRoot — final inside-root check will catch escapes */ }
    }
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
    const inside = await isPathInsideRoot(meshRoot, candidate).catch(() => false);
    if (!inside) {
      send403(res, 'Path outside mesh root');
      return;
    }

    // Sensitive check (use relative path from meshRoot)
    let canonRoot;
    try { canonRoot = await realpath(meshRoot); } catch { canonRoot = meshRoot; }
    const rel = relative(canonRoot, candidate);
    if (isSensitivePath(rel)) {
      send403(res, 'Sensitive path denied');
      return;
    }

    // Stat
    let fileStat;
    try {
      fileStat = await stat(candidate);
    } catch {
      send404(res);
      return;
    }
    if (!fileStat.isFile()) {
      send403(res, 'Not a file');
      return;
    }

    // Size cap
    if (fileStat.size > FILE_SIZE_CAP) {
      sendJson(res, 200, {
        kind: 'metadata',
        path: rel,
        size: fileStat.size,
        reason: 'file_too_large'
      });
      return;
    }

    // Text-only
    if (!isTextFile(candidate)) {
      sendJson(res, 200, {
        kind: 'metadata',
        path: rel,
        size: fileStat.size,
        reason: 'binary_file'
      });
      return;
    }

    // Read and serve
    let content;
    try {
      content = await readFile(candidate, 'utf8');
    } catch {
      send404(res);
      return;
    }

    sendJson(res, 200, { kind: 'text', path: rel, content });
    return;
  }

  if (pathname === '/api/skills' && req.method === 'GET') {
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const skills = skillsView(snapshot);
    sendJson(res, 200, skills);
    return;
  }

  if (pathname === '/api/mcps' && req.method === 'GET') {
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const mcps = mcpsView(snapshot);
    sendJson(res, 200, mcps);
    return;
  }

  // -----------------------------------------------------------------------
  // Live change stream: GET /api/events (SSE) — coarse, secret-safe.
  // -----------------------------------------------------------------------
  if (pathname === '/api/events' && req.method === 'GET' && sse) {
    await sse.addClient(req, res);
    return;
  }

  // -----------------------------------------------------------------------
  // Live board activity: GET /api/activity — redacted agent/edge/event model.
  // -----------------------------------------------------------------------
  if (pathname === '/api/activity' && req.method === 'GET') {
    sendJson(res, 200, await loadActivitySnapshot(meshRoot));
    return;
  }

  // -----------------------------------------------------------------------
  // Collaboration analytics: GET /api/collab?days=N (default 30, cap 90) —
  // aggregates every manifest agent's a2a run records per directed (from,to)
  // pair: count/ok/fail/running, per-mode counts and lastAt are ALWAYS served
  // (text-free, like /api/activity). `topics` — the actual help text (the
  // child delegate record's `task`, else `summary_preview`) — is privacy-
  // gated: only present when the session-log gate is on (sessionLogEnabled,
  // the same condition that exposes transcripts).
  // -----------------------------------------------------------------------
  if (pathname === '/api/collab' && req.method === 'GET') {
    const daysRaw = url.searchParams.get('days');
    let days = 30;
    if (daysRaw !== null) {
      days = Number(daysRaw);
      if (!Number.isFinite(days) || days < 1) {
        sendJson(res, 400, { ok: false, error: { code: 'bad_days', message: 'days must be a number >= 1' } });
        return;
      }
      days = Math.min(Math.floor(days), COLLAB_MAX_DAYS);
    }

    let manifest = null;
    try { manifest = await readManifest(meshRoot); } catch { manifest = null; }
    const agents = manifest?.agents ?? [];

    // Cutoff by FILENAME date-suffix: a2a-YYYY-MM-DD.jsonl with date >= today
    // minus (days-1); lexicographic compare is chronological for zero-padded
    // dates (same idiom as the activity-stats route).
    const now = new Date();
    const f = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    const fromYmd = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;

    let records = [];
    for (const agent of agents) {
      const logDir = join(meshRoot, agent.root, '.agent-mesh', 'logs');
      let files = [];
      try { files = await readdir(logDir); } catch { continue; }
      const picked = files
        .filter((fn) => fn.startsWith('a2a-') && (fn.endsWith('.jsonl') || fn.endsWith('.json')))
        .filter((fn) => { const m = fn.slice('a2a-'.length).match(/^(\d{4}-\d{2}-\d{2})/); return m != null && m[1] >= fromYmd; })
        .sort()
        .slice(-COLLAB_MAX_FILES);
      for (const fn of picked) {
        for (const r of await readRunLogRecords(join(logDir, fn))) records.push(r);
      }
    }
    records = dedupeRunRecords(records); // start+final share id → final wins

    // Aggregate per directed (from,to) pair.
    const byPair = new Map();
    for (const r of records) {
      if (!r || typeof r.from !== 'string' || !r.from || typeof r.to !== 'string' || !r.to) continue;
      const key = `${r.from}|${r.to}`;
      let agg = byPair.get(key);
      if (!agg) {
        agg = { from: r.from, to: r.to, count: 0, ok: 0, fail: 0, running: 0, modes: { ask: 0, do: 0 }, lastAt: null, _records: [] };
        byPair.set(key, agg);
      }
      agg.count += 1;
      if (r.status === 'completed') agg.ok += 1;
      else if (r.finished_at) agg.fail += 1;
      if (!r.finished_at) agg.running += 1;
      if (typeof r.mode === 'string' && r.mode) agg.modes[r.mode] = (agg.modes[r.mode] ?? 0) + 1;
      const at = String(r.finished_at || r.started_at || '');
      if (at && (agg.lastAt === null || at > agg.lastAt)) agg.lastAt = at;
      agg._records.push(r);
    }

    const topicsAvailable = !!sessionLogEnabled;

    // Child task lookup: each distinct child_log_path is read ONCE and indexed
    // id → task; a missing/unreadable file degrades to an empty map.
    const childTaskMaps = new Map();
    const childTasksFor = async (logPath) => {
      let map = childTaskMaps.get(logPath);
      if (!map) {
        map = new Map();
        for (const rec of await readRunLogRecords(logPath)) {
          if (rec && rec.id && typeof rec.task === 'string' && rec.task) map.set(rec.id, rec.task);
        }
        childTaskMaps.set(logPath, map);
      }
      return map;
    };

    const edges = [];
    for (const agg of byPair.values()) {
      const edge = { from: agg.from, to: agg.to, count: agg.count, ok: agg.ok, fail: agg.fail, running: agg.running, modes: agg.modes, lastAt: agg.lastAt };
      if (topicsAvailable) {
        const topics = [];
        const newestFirst = agg._records
          .slice()
          .sort((a, b) => String(b.finished_at || b.started_at || '').localeCompare(String(a.finished_at || a.started_at || '')));
        for (const r of newestFirst) {
          if (topics.length >= COLLAB_TOPICS_PER_EDGE) break;
          let text = null;
          if (typeof r.child_log_path === 'string' && r.child_log_path && r.child_run_id) {
            const task = (await childTasksFor(r.child_log_path)).get(r.child_run_id);
            if (task) text = task;
          }
          if (text === null && typeof r.summary_preview === 'string' && r.summary_preview) text = r.summary_preview;
          if (text === null) continue; // neither child task nor preview → skip the record
          topics.push({
            text: text.slice(0, COLLAB_TOPIC_CHARS),
            at: String(r.finished_at || r.started_at || ''),
            ok: r.status === 'completed'
          });
        }
        edge.topics = topics;
      }
      edges.push(edge);
    }
    // Deterministic order: busiest pair first, then pair name.
    edges.sort((a, b) => (b.count - a.count) || `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`));

    sendJson(res, 200, { edges, topicsAvailable });
    return;
  }

  // -----------------------------------------------------------------------
  // Image proxy: GET /api/img?url=  (gated: allowShell OR injected imgFetcher + auth)
  // -----------------------------------------------------------------------
  if (pathname === '/api/img' && req.method === 'GET') {
    if (!fetchImage) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled', message: 'image proxy is disabled; start the dashboard with --allow-shell' } }); return; }
    const imgUrl = url.searchParams.get('url') ?? '';
    try {
      const { contentType, body } = await fetchImage(imgUrl);
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': body.length,
        'Cache-Control': 'private, max-age=300'
      });
      res.end(body);
    } catch (err) {
      // Only surface img-proxy's deliberate domain codes; coerce any Node
      // internal (ERR_INVALID_URL / ENOTFOUND / ECONNRESET …) to a generic code
      // so getaddrinfo names / upstream details don't leak to the client.
      const KNOWN = new Set(['scheme', 'host', 'address', 'redirect', 'upstream', 'content_type', 'magic', 'too_large', 'timeout']);
      const code = KNOWN.has(err.code) ? err.code : 'img_error';
      sendJson(res, 400, { ok: false, error: { code, message: code === 'img_error' ? 'image request failed' : err.message } });
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Native CLI entry point (PRIVILEGED, opt-in): plan → launch.
  //   POST /api/agent/:name/shell/plan    → { planId, command } and reserves
  //        the agent's canonical session id when one does not exist yet
  //   POST /api/agent/:name/shell/launch  → opens the operator's terminal
  // Disabled unless the dashboard was started with allowShell.
  // -----------------------------------------------------------------------
  if (pathname.startsWith('/api/agent/') &&
      (pathname.endsWith('/shell/plan') || pathname.endsWith('/shell/launch')) &&
      req.method === 'POST') {
    if (!shellLauncher) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled', message: 'native CLI launch is disabled; start the dashboard with --allow-shell' } }); return; }

    const isPlan = pathname.endsWith('/shell/plan');
    const suffix = isPlan ? '/shell/plan' : '/shell/launch';
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -suffix.length));
    if (!name) { send404(res); return; }

    // membership + containment (gate before any side effect)
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = (snapshot?.manifest?.agents ?? []).find(a => a.name === name);
    if (!entry) { send404(res); return; }
    let canonRoot;
    try { canonRoot = await realpath(resolve(join(meshRoot, entry.root))); } catch { send404(res); return; }
    const inside = await isPathInsideRoot(meshRoot, canonRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    let body;
    try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }

    try {
      if (isPlan) {
        let sessionId = await readSessionId(meshRoot, canonRoot);
        if (!sessionId) {
          sessionId = randomUUID();
          await writeSessionId(meshRoot, canonRoot, sessionId);
        }

        const resolveShellTranscript = sessionIndex?.resolveTranscript
          ? (root, id) => sessionIndex.resolveTranscript(root, id)
          : (root, id) => defaultResolveTranscript(root, id, { meshRoot });
        let hasTranscript = false;
        try {
          await resolveShellTranscript(canonRoot, sessionId);
          hasTranscript = true;
        } catch (err) {
          if (err.code !== 'not_found') throw err;
        }

        // The terminal buttons must reopen the dashboard-owned canonical thread
        // exactly. `claude --continue` is a recency heuristic and can pick a
        // different transcript when another CLI/session touched the same cwd.
        const plan = hasTranscript
          ? await shellLauncher.buildPlan({ agentRoot: canonRoot, entry, resumeId: sessionId })
          : await shellLauncher.buildPlan({ agentRoot: canonRoot, entry, sessionId });
        sendJson(res, 200, { ok: true, ...plan });
      } else {
        const result = await shellLauncher.launch(String(body.planId || ''));
        sendJson(res, 200, result);
      }
    } catch (err) {
      const code = err.code || 'internal';
      const status = code === 'reserved_name' ? 409 : code === 'plan_expired' ? 410 : code === 'bad_input' ? 400 : 500;
      sendJson(res, status, { ok: false, error: { code, message: err.message } });
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Session log + live mirror (PRIVILEGED, opt-in):
  //   GET  /api/agent/:name/session/list           -> session rows (index)
  //   GET  /api/agent/:name/session/:id/transcript -> windowed line/live records
  //   GET  /api/agent/:name/session/:id/stream     -> SSE live records from the
  //        transcript tail and dashboard-owned stdout hub; seq is one cursor
  //   POST /api/agent/:name/session/message        -> 202 { turnId } (driven turn)
  //   POST /api/agent/:name/session/stop           -> 200 { ok }
  // Disabled unless the dashboard was started with --allow-shell.
  // -----------------------------------------------------------------------
  if (pathname.startsWith('/api/agent/') && pathname.includes('/session/')) {
    if (!sessionRunner && !sessionMirror && !sessionIndex) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled', message: 'native session is disabled; start the dashboard with --allow-shell' } }); return; }
    // Two forms: the flat per-agent verbs (message/stop/list), and the id-bearing
    // routes (transcript + the live mirror stream + resume/select). A malicious id
    // is constrained by the 36-char UUID shape and, on transcript/stream, still
    // routes through resolveTranscript (containment), never a hand-joined path.
    // `resume` is the single-active selection verb (setActiveSession); the
    // expectedActiveId echoed back on the next /message is a client-supplied
    // OPTIMISTIC-CONCURRENCY token compared against server state — it never feeds
    // the writable root / call-path / depth (those come from process env in the
    // runner). open-terminal launches an INDEPENDENT terminal-owned `claude
    // --resume <id>` session (no lease — the external terminal owns its own
    // session; single-active still applies at the lease layer when a turn runs).
    const m = pathname.match(/^\/api\/agent\/(.+?)\/session\/(?:(message|stop|list|resume-command)|([0-9a-f-]{36})\/(transcript|stream|resume|open-terminal|rename|delete))$/i);
    if (!m) { send404(res); return; }
    const name = decodeURIComponent(m[1]);
    const id = m[3] || null;
    const verb = m[2] || m[4];

    // membership + containment (gate before any side effect)
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = (snapshot?.manifest?.agents ?? []).find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    if (verb === 'list' && req.method === 'GET') {
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      const sessions = await sessionIndex.listSessions(canonRoot);
      // Strict one-session-per-agent: the agent OWNS exactly the canonical id in
      // the session-store (<temp>/agent-mesh/sessions/<hash(meshRoot)>/<hash(agentRoot)>.json).
      // Expose it so the frontend (and the CLI launch button) select/tail THAT id,
      // never "newest by mtime". Stray transcripts are listed but not auto-selected.
      const canonicalId = await readSessionId(meshRoot, canonRoot).catch(() => null);
      if (canonicalId && !sessions.some((s) => s.id === canonicalId)) {
        sessions.unshift({
          id: canonicalId,
          turns: 0,
          turnsApprox: false,
          firstPrompt: '',
          originSource: 'dashboard',
          active: true,
          transcriptPath: null,
          lineCount: 0,
          checkpointPending: true
        });
      }
      const projectsDir = join(homedir(), '.claude', 'projects', encodeProjectDir(canonRoot));
      sendJson(res, 200, {
        ok: true, sessions, canonicalId, projectsDir,
        digesting: !!rotationManager?.isDigesting?.(name),
        rotationError: rotationManager?.lastErrorFor?.(name) ?? null
      });
      return;
    }

    // GET /session/:id/transcript?beforeSeq=&limit=
    // A windowed slice of line records { seq, events } where seq = the 1-based
    // transcript LINE INDEX — the same cursor the live /stream mirror emits, so
    // both agree. Reverse pagination: return records with seq < beforeSeq, keeping
    // the newest `limit` of them. The id → transcript path resolution goes through
    // resolveTranscript (UUID + index-only + realpath containment); paths are never
    // hand-joined here. Malformed transcript lines degrade to a `raw` event and are
    // never thrown.
    if (verb === 'transcript' && req.method === 'GET') {
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      let transcriptPath = null;
      const canonicalId = await readSessionId(meshRoot, canonRoot).catch(() => null);
      try {
        transcriptPath = await sessionIndex.resolveTranscript(canonRoot, id);
      } catch (e) {
        // A dashboard-managed live turn can exist before Claude checkpoints the
        // transcript. Let the canonical id render its live buffer as an empty /
        // pending transcript; all other ids remain a clean 404.
        if (id !== canonicalId || !sessionLive) {
          sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } });
          return;
        }
      }
      const beforeSeq = Number(url.searchParams.get('beforeSeq') || 0) || Infinity;
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 200) || 200));
      const raw = transcriptPath ? await readFile(transcriptPath, 'utf8').catch(() => '') : '';
      const lines = raw.split('\n');
      const records = [];
      for (let i = 0; i < lines.length; i++) {
        const seq = i + 1; // 1-based line index cursor (matches the mirror)
        if (!lines[i].trim()) continue;
        const events = parseTranscriptLine(lines[i]).map(redactSessionEvent);
        if (events.length) records.push({ seq, events });
      }
      const seen = new Set(records.map((r) => r.seq));
      for (const rec of sessionLive?.window?.(id, { beforeSeq, limit }) || []) {
        if (!seen.has(rec.seq)) records.push(rec);
      }
      records.sort((a, b) => a.seq - b.seq);
      // Newest-last window of <=limit records ending before beforeSeq.
      const windowed = records.filter((r) => r.seq < beforeSeq).slice(-limit);
      sendJson(res, 200, {
        ok: true,
        records: windowed,
        hasMore: windowed.length > 0 && windowed[0].seq > 1,
        nextCursor: windowed.length ? windowed[0].seq : null
      });
      return;
    }

    // GET /session/:id/stream - the canvas's live session feed. Transcript
    // tailing carries external terminal sessions and checkpointed history; the
    // dashboard-owned stdout hub carries live turns before Claude checkpoints a
    // transcript. Both sources share one seq cursor for reconnect/resume.
    if (verb === 'stream' && req.method === 'GET') {
      if (!sessionMirror && !sessionLive) { sendJson(res, 503, { ok: false, error: { code: 'session_mirror_unavailable', message: 'session mirror backend is not available' } }); return; }
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      let transcriptPath = null;
      const canonicalId = await readSessionId(meshRoot, canonRoot).catch(() => null);
      try {
        transcriptPath = await sessionIndex.resolveTranscript(canonRoot, id);
      } catch (e) {
        if (id !== canonicalId || !sessionLive) {
          // bad_id / not_found / containment → a clean 404; never a crash or traversal.
          sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } });
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      // Resume cursor. A fresh browser EventSource cannot set Last-Event-ID (the
      // browser only sends it on its OWN auto-reconnects), so the frontend threads
      // its transcript cursor via ?fromSeq= on the initial open. Precedence:
      //   Last-Event-ID header (mid-stream auto-reconnect)  >  ?fromSeq query  >  0
      // This seals the past→live handoff: the live tail starts exactly where the
      // rendered transcript ended (no double-render, no subscribe-at-0 gap loop).
      const headerSeq = Number(req.headers['last-event-id'] || 0) || 0;
      const querySeq = Number(url.searchParams.get('fromSeq') || 0) || 0;
      const lastSeq = Math.max(0, req.headers['last-event-id'] != null ? headerSeq : querySeq);
      const tailOnly = url.searchParams.get('tail') === '1' && req.headers['last-event-id'] == null;
      // subscribe() is async (it awaits the tailer's initial drain so the cursor
      // decision sees the file at EOF). The client could disconnect during that
      // await, so register teardown against a `let sub` that may still be null:
      // closed=true then short-circuits the assignment + closes immediately.
      const subs = [];
      let closed = false;
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
      ping.unref?.();
      // Track this live response so srv.close() can end it (an active streaming
      // response otherwise blocks httpServer.close() until the keep-alive timeout).
      mirrorStreams?.add(res);
      // Teardown: release the mirror subscription + heartbeat on disconnect so we
      // never leak a subscriber (and, when it's the last one, the mirror pauses its
      // file watcher). A prior flakiness source — get it right.
      req.on('close', () => {
        clearInterval(ping);
        closed = true;
        for (const sub of subs) { try { sub.close(); } catch { /* ignore */ } }
        mirrorStreams?.delete(res);
        // The client is gone; tear the server-side socket down rather than leaving
        // it keep-alive-idle (which would hold httpServer.close() open until the
        // keep-alive timeout). end() is best-effort; destroy() guarantees release.
        try { res.end(); } catch { /* already gone */ }
        try { res.socket?.destroy(); } catch { /* already gone */ }
      });
      // Records are already redactSessionEvent-scrubbed inside session-mirror, so
      // no re-redaction here.
      let highestSent = lastSeq;
      const writeRecord = (rec) => {
        try {
          if (rec && rec.type === 'replay_gap') { res.write('event: gap\ndata: {}\n\n'); return; }
          if (!rec || rec.seq <= highestSent) return;
          highestSent = rec.seq;
          res.write(`id: ${rec.seq}\nevent: record\ndata: ${JSON.stringify(rec)}\n\n`);
        } catch { /* dead socket; cleanup runs on close */ }
      };
      if (transcriptPath && sessionMirror) {
        subs.push(await sessionMirror.subscribe(id, transcriptPath, writeRecord, lastSeq, { fastForward: tailOnly }));
      }
      if (sessionLive) {
        subs.push(sessionLive.subscribe(id, writeRecord, highestSent));
      }
      // If the client disconnected during the await above, close fired before sub
      // existed — release the now-resolved subscription immediately so it can't leak.
      if (closed) { for (const sub of subs) { try { sub.close(); } catch { /* ignore */ } } }
      return;
    }

    // GET /session/resume-command?id=<uuid|latest|new> — return the copy-paste
    // command (shell + cwd + command string) that resumes a session in the user's
    // OWN terminal. Replaces the EDR-blocked ⌘ Terminal spawn (2026-06-13 spec §5).
    // `latest` selects the newest USER-ORIGIN session (not peer:/worker: rows).
    // `new` produces a bare `claude` command. Always exact id (--resume/--session-id),
    // never `--continue` (recency heuristic — CLAUDE.md).
    if (verb === 'resume-command' && req.method === 'GET') {
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      const want = url.searchParams.get('id') || 'latest';
      let mode = 'resume', sid = want;
      if (want === 'new') { mode = 'new'; sid = null; }
      else {
        if (want === 'latest') {
          const rows = await sessionIndex.listSessions(canonRoot);
          const user = rows.filter((s) => { const o = String(s.originSource || 'cli'); return !(o.startsWith('peer:') || o.startsWith('worker:')); });
          sid = user[0]?.id ?? (await readSessionId(meshRoot, canonRoot).catch(() => null)) ?? rows[0]?.id ?? null;
          if (!sid) { sendJson(res, 404, { ok: false, error: { code: 'not_found' } }); return; }
        }
        try { await sessionIndex.resolveTranscript(canonRoot, sid); }
        catch (e) {
          const canonical = e.code === 'not_found' ? await readSessionId(meshRoot, canonRoot).catch(() => null) : null;
          if (canonical && canonical === sid) mode = 'seed';   // reserved first launch (mirrors open-terminal)
          else { sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } }); return; }
        }
      }
      try {
        sendJson(res, 200, { ok: true, ...buildResumeCommand({ agentRoot: canonRoot, sessionId: sid, mode }) });
      } catch (e) { sendJson(res, 404, { ok: false, error: { code: e.code || 'bad_id' } }); }
      return;
    }

    // POST /session/:id/open-terminal — DEPRECATED (2026-06-13 spec §5): UI uses the
    // resume-command copy flow; route kept for API compat.
    // Launch an external terminal running `claude --resume <id>` in the agent's
    // folder. NO lease is taken: the external terminal owns its own claude session;
    // the dashboard just launches it. The id is validated through resolveTranscript
    // (containment) BEFORE any launch — a bad/unknown id is a clean 404, never a
    // launch. Provenance records {kind:'open',source:'terminal'}. We warn the caller
    // that this session runs OUTSIDE dashboard single-active coordination
    // (single-active still applies at the lease layer when a turn actually runs).
    if (verb === 'open-terminal' && req.method === 'POST') {
      if (!shellLauncher) { sendJson(res, 503, { ok: false, error: { code: 'shell_launcher_unavailable', message: 'native CLI launcher backend is not available' } }); return; }
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      // Validate the id resolves to a real session for this agent before launching.
      // One exception: the agent's RESERVED canonical id may have no transcript yet
      // (shell/plan reserves it before claude ever starts; /session/list surfaces it,
      // so the pane offers it). That is a FIRST LAUNCH — seed with --session-id,
      // mirroring shell/plan — never a 404 on a session the UI itself offered.
      let seedSessionId = null;
      try {
        await sessionIndex.resolveTranscript(canonRoot, id);
      } catch (e) {
        const canonical = e.code === 'not_found' ? await readSessionId(meshRoot, canonRoot) : null;
        if (canonical && canonical === id) {
          seedSessionId = id;
        } else {
          sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } });
          return;
        }
      }
      try {
        const plan = seedSessionId
          ? await shellLauncher.buildPlan({ agentRoot: canonRoot, entry, sessionId: seedSessionId })
          : await shellLauncher.buildPlan({ agentRoot: canonRoot, entry, resumeId: id });
        // Single-click UX: chain launch right after buildPlan so the OS terminal
        // actually opens — without this the endpoint returned only the plan and
        // the user had to copy `command` out of the response themselves.
        // shellLauncher.launch is optional only for test stubs; real launchers
        // expose it (see src/dashboard/shell-launcher.js).
        let launched = null;
        if (typeof shellLauncher.launch === 'function') {
          launched = await shellLauncher.launch(plan.planId);
        }
        // Provenance: an external terminal-owned session was opened for this id.
        // This is bookkeeping only. In managed/sandboxed environments the
        // dashboard may be able to launch the terminal but not write operator-home
        // provenance files; that must not make the UI report the launch failed.
        let provenanceWarning = null;
        if (sessionIndex.recordEvent) {
          try {
            await sessionIndex.recordEvent(meshRoot, { kind: 'open', source: 'terminal', agentRoot: canonRoot, sessionId: id, terminalApp: process.platform });
          } catch (err) {
            provenanceWarning = { code: err.code || 'record_event_failed' };
          }
        }
        sendJson(res, 200, {
          ok: true,
          ...plan,
          opened: !!(launched && launched.opened),
          provenanceWarning,
          warning: 'This opens an independent terminal-owned claude session that runs OUTSIDE dashboard single-active coordination.'
        });
      } catch (err) {
        sendJson(res, err.code === 'reserved_name' ? 409 : 500, { ok: false, error: { code: err.code || 'internal', message: err.message } });
      }
      return;
    }

    // POST /session/:id/rename — set the mesh-side display label for a session.
    // The id is validated through resolveTranscript (UUID + index-membership +
    // realpath containment) BEFORE any write — a bad/unknown id is a clean 404.
    // The label store is runtime-side (<temp>/agent-mesh/sessions/<hash>/labels.json); it
    // never touches Claude Code's transcript. An empty/blank name clears the label.
    if (verb === 'rename' && req.method === 'POST') {
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      let body;
      try { body = JSON.parse((await readBodyCapped(req, CONSOLE_BODY_CAP)) || '{}'); }
      catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      try {
        await sessionIndex.resolveTranscript(canonRoot, id);
      } catch (e) {
        sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } });
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      const label = await sessionIndex.setLabel(meshRoot, id, name);
      sendJson(res, 200, { ok: true, label });
      return;
    }

    // POST /session/:id/delete — PERMANENTLY delete the session's real transcript.
    // deleteSession resolves the path via resolveTranscript (the security gate) and
    // unlinks it — never a hand-joined path. Resolve errors (bad/unknown id) → 404.
    // The mesh-side label is also dropped so a recreated id can't inherit it.
    if (verb === 'delete' && req.method === 'POST') {
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      try {
        await sessionIndex.deleteSession(canonRoot, id);
      } catch (e) {
        sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } });
        return;
      }
      if (sessionIndex.deleteLabel) { try { await sessionIndex.deleteLabel(meshRoot, id); } catch { /* label drop is best-effort */ } }
      sendJson(res, 200, { ok: true });
      return;
    }

    // message/stop/resume all drive the session runner; without it → 503.
    if ((verb === 'message' || verb === 'stop' || verb === 'resume') && !sessionRunner) {
      sendJson(res, 503, { ok: false, error: { code: 'session_runner_unavailable', message: 'session runner backend is not available' } });
      return;
    }

    // POST /session/:id/resume — select the single active session (no lease, no
    // turn). Returns { activeId, rev }; the frontend echoes activeId as
    // expectedActiveId on the next /message so a concurrent re-select is caught.
    if (verb === 'resume' && req.method === 'POST') {
      // Validate the id resolves to a real session for this agent BEFORE selecting
      // it active (consistent with transcript/stream/open-terminal). A
      // well-formed-but-nonexistent id is a clean 404, not a deferred turn-time
      // failure. Anti-spoof unaffected: id never feeds the writable root/path/depth.
      if (!sessionIndex) { sendJson(res, 503, { ok: false, error: { code: 'session_index_unavailable', message: 'session index backend is not available' } }); return; }
      const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
      try {
        await sessionIndex.resolveTranscript(canonRoot, id);
      } catch (e) {
        sendJson(res, 404, { ok: false, error: { code: e.code || 'not_found' } });
        return;
      }
      try {
        const sel = await sessionRunner.setActiveSession(name, id);
        sendJson(res, 200, { ok: true, ...sel });
      } catch (err) {
        const code = err.code || 'internal';
        const status = code === 'bad_id' ? 400 : code === 'unknown_agent' ? 404 : 500;
        sendJson(res, status, { ok: false, error: { code, message: err.message } });
      }
      return;
    }

    if (verb === 'message' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBodyCapped(req, CONSOLE_BODY_CAP)) || '{}'); }
      catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
      const text = typeof body.text === 'string' ? body.text : '';
      const force = !!body.force;
      // expectedActiveId: client-supplied optimistic-concurrency token. Threaded
      // ONLY into runTurn's active-session check; never into the writable root,
      // call-path, or depth (those are read from process env inside the runner).
      const expectedActiveId = typeof body.expectedActiveId === 'string' ? body.expectedActiveId : undefined;
      try {
        const { turnId } = await sessionRunner.runTurn({ agentName: name, text, force, expectedActiveId });
        sendJson(res, 202, { ok: true, turnId });
      } catch (err) {
        const code = err.code || 'internal';
        // session_busy / session_busy_external (lease held) and active_changed
        // (the active session moved under a stale client) are all 409 — the client
        // reconciles and retries. active_changed carries the current activeId.
        const status = (code === 'session_busy' || code === 'session_busy_external' || code === 'active_changed') ? 409 : code === 'unknown_agent' ? 404 : 500;
        sendJson(res, status, { ok: false, error: { code, message: err.message, owner: err.owner, activeId: err.activeId } });
      }
      return;
    }

    if (verb === 'stop' && req.method === 'POST') {
      await sessionRunner.stop(name);
      sendJson(res, 200, { ok: true });
      return;
    }

    send404(res);
    return;
  }

  // -----------------------------------------------------------------------
  // Console: POST /api/agent/:name/message  { text, mode? }
  // Brokers a real A2A SendMessage (ask-only) and returns the final Task.
  // -----------------------------------------------------------------------
  if (
    pathname.startsWith('/api/agent/') &&
    pathname.endsWith('/message') &&
    req.method === 'POST'
  ) {
    const inner = pathname.slice('/api/agent/'.length, -'/message'.length);
    const name = decodeURIComponent(inner);
    if (!name) { send404(res); return; }

    // In-dashboard chat is off by default — drive Claude from the external CLI.
    if (!chatEnabled) {
      sendJson(res, 403, { ok: false, error: { code: 'chat_disabled', message: 'in-dashboard chat is disabled; start the dashboard with --enable-chat' } });
      return;
    }

    // Read body with cap.
    let raw;
    try {
      raw = await readBodyCapped(req, CONSOLE_BODY_CAP);
    } catch (err) {
      if (err.tooLarge) {
        res.setHeader('Connection', 'close');
        sendJson(res, 413, { ok: false, error: { code: 'too_large', message: 'request body too large' } });
      } else {
        sendJson(res, 400, { ok: false, error: { code: 'bad_input', message: 'could not read request body' } });
      }
      return;
    }

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad_input', message: 'request body must be JSON' } });
      return;
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const mode = typeof body.mode === 'string' ? body.mode : 'ask';

    // Abort the in-flight spawn if the client disconnects.
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    req.on('close', onClose);

    try {
      const result = await consoleBroker.send({ agentName: name, text, mode, signal: controller.signal });
      if (!res.writableEnded) {
        sendJson(res, 200, { ok: true, task: result.task, delegations: result.delegations });
      }
    } catch (err) {
      const code = err instanceof ConsoleError ? err.code : 'internal';
      const message = err.message || 'console error';
      if (!res.writableEnded) {
        sendJson(res, consoleErrorStatus(code), { ok: false, error: { code, message } });
      }
    } finally {
      req.removeListener('close', onClose);
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Concierge (mobile phone front-door, spec 2026-06-21).
  //   POST /api/concierge/message  → one ask-only chat turn; never writes.
  //   POST /api/concierge/confirm  → the SINGLE write surface (gh issue create),
  //                                  fired only on the owner's explicit tap.
  // Both sit behind the same-origin gate + cookie already enforced above.
  // -----------------------------------------------------------------------
  if (pathname === '/api/concierge/message' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse((await readBodyCapped(req, 64 * 1024)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
    try {
      const out = await concierge.message({ history: payload.history, text: payload.text });
      sendJson(res, 200, { ok: true, ...out });
    } catch (err) {
      if (err instanceof ConciergeError) sendJson(res, err.status, { ok: false, error: { code: 'concierge', message: err.message, detail: err.detail } });
      else sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(err && err.message || err) } });
    }
    return;
  }

  if (pathname === '/api/concierge/confirm' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse((await readBodyCapped(req, 64 * 1024)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
    try {
      const out = await concierge.confirm({ title: payload.title, body: payload.body, labels: payload.labels });
      sendJson(res, 200, { ok: true, ...out });
    } catch (err) {
      if (err instanceof ConciergeError) sendJson(res, err.status, { ok: false, error: { code: 'concierge', message: err.message, detail: err.detail } });
      else sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(err && err.message || err) } });
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Static asset serving: GET / → index.html; GET /app.js, /app.css, etc.
  // Served ONLY behind the auth cookie (already checked above).
  // Path must be within PUBLIC_DIR (no traversal).
  // -----------------------------------------------------------------------

  if (req.method === 'GET') {
    // Map / to board2.html (the dashboard; the legacy index.html/app.js was removed).
    // Map /m to the mobile concierge PWA (spec 2026-06-21). Its assets live under
    // /mobile/* and are referenced absolutely so they resolve from the /m page.
    const assetPath = pathname === '/' ? '/board2.html'
      : pathname === '/m' ? '/mobile/index.html'
      : pathname;

    // Reject traversal attempts (%2e, double-dot, etc.)
    if (assetPath.includes('..') || assetPath.includes('\0')) {
      send403(res, 'Invalid asset path');
      return;
    }

    // render-core.js is the pure render module (src/dashboard/render-core.js, one
    // level above public) imported by the browser's result-canvas.js as
    // `../render-core.js` → URL `/render-core.js`. Serve it from its real location
    // via an EXACT literal map (no user-controlled path join → no traversal).
    let filePath;
    if (assetPath === '/render-core.js') {
      filePath = join(__dirname, 'render-core.js');
    } else {
      // Build the absolute file path and check it stays inside PUBLIC_DIR
      filePath = join(PUBLIC_DIR, assetPath);
      if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
        send403(res, 'Asset path outside public directory');
        return;
      }
    }

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      send404(res);
      return;
    }

    if (!fileStat.isFile()) {
      send404(res);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const mime = STATIC_MIME[ext] ?? 'application/octet-stream';

    let content;
    try {
      content = await readFile(filePath);
    } catch {
      send404(res);
      return;
    }

    // Disable HTTP caching for the dashboard assets. Without this, every code
    // change requires the user to hard-reload — they otherwise hit a stale
    // app.js/session-log.js and end up with mismatched JS+server (which
    // surfaced as e.g. "scope switch still shows previous agent" because the
    // old setChatAgent closure was still bound). The dashboard is a single-
    // page app served from localhost, so no real cache wins anyway.
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
      'Cache-Control': 'no-store, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(content);
    return;
  }

  // Unknown route
  send404(res);
}

// ---------------------------------------------------------------------------
// SSE hub: /api/events — coarse, secret-safe change notifications.
// The watcher is created lazily on the first client and torn down when the last
// disconnects, so an idle dashboard does no polling.
// ---------------------------------------------------------------------------

export function createSseHub({ meshRoot, pollMs, onMeshChange = () => {} }) {
  const clients = new Set();
  let watcher = null;

  function emit(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* dead socket; cleanup runs on close */ }
    }
  }

  // On any watched change emit the coarse `change` event AND a fresh, redacted
  // `activity` snapshot (run-log driven). The watcher already debounces, so this
  // re-scan is bounded (up to 2×ACTIVITY_DATE_FILES files per agent: the cap is
  // applied per prefix, delegate-* and a2a-*).
  async function onWatcherChange(evt) {
    emit('change', evt);
    try {
      emit('activity', await loadActivitySnapshot(meshRoot));
    } catch { /* transient; next change retries */ }
    try { onMeshChange(); } catch { /* auto-sync trigger must not break the SSE stream */ }
  }

  async function ensureWatcher() {
    if (watcher) return;
    let agentDirs = [];
    try {
      const manifest = await readManifest(meshRoot);
      agentDirs = (manifest.agents ?? [])
        .map((a) => String(a.root || '').replace(/^\.\//, '').split('/')[0])
        .filter(Boolean);
    } catch { /* no manifest → scope collapses to 'mesh' */ }
    watcher = createMeshWatcher({
      meshRoot,
      agentDirs,
      pollMs,
      onChange: onWatcherChange
    });
    await watcher.ready;
  }

  async function addClient(req, res) {
    // Establish the watcher baseline BEFORE announcing ': connected' — otherwise
    // a change the client triggers immediately after connecting could be folded
    // into the baseline scan and never reported.
    await ensureWatcher();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    clients.add(res);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(res);
      if (clients.size === 0 && watcher) {
        watcher.close();
        watcher = null;
      }
    };
    req.on('close', cleanup);
  }

  function close() {
    for (const res of clients) {
      try { res.end(); } catch { /* already gone */ }
    }
    clients.clear();
    if (watcher) { watcher.close(); watcher = null; }
  }

  return { addClient, close, emitSync: (data) => emit('sync', data), onWatcherChange };
}

// ---------------------------------------------------------------------------
// createDashboardServer
// ---------------------------------------------------------------------------

/**
 * Create (but do not start) a dashboard HTTP server.
 *
 * @param {object} opts
 *   @param {string}  opts.meshRoot  absolute path to the mesh root
 *   @param {number}  [opts.port]    TCP port (0 = OS-assigned ephemeral)
 *   @param {string}  [opts.token]   auth token (generated if omitted)
 * @returns {{ start(): Promise<void>, close(): Promise<void>, url: string, token: string }}
 */
/**
 * Read a persisted dashboard token from `<meshRoot>/.agent-mesh/dashboard-token`
 * if present and well-formed; otherwise generate a fresh 32-byte hex token,
 * persist it with 0600 perms, and return it.
 *
 * This keeps old browser tabs / saved URLs valid across `agent-mesh dashboard`
 * restarts — without it every restart silently invalidates the cookie and the
 * UI shows 403s on `/api/agent/...` calls (page renders, but detail/list
 * endpoints fail authentication).
 */
function loadOrCreatePersistedToken(meshRoot) {
  const dir = join(meshRoot, '.agent-mesh');
  const file = join(dir, 'dashboard-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing;
  } catch { /* missing or unreadable → fall through to generate */ }
  const fresh = randomBytes(32).toString('hex');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, fresh + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);  // belt-and-suspenders: enforce even if umask masked it
  } catch (e) {
    // Persistence is best-effort. If the FS is read-only or sandboxed, fall
    // back to the old behaviour: a working but per-run token.
    process.stderr.write(`dashboard: could not persist auth token to ${file}: ${e.message}\n`);
  }
  return fresh;
}

export function createDashboardServer({ meshRoot, port = 7077, token, allowedHosts, concierge, consoleBroker, watchPollMs = 1000, allowShell = false, chat = false, shellLauncher, sessionRunner, sessionIndex, sessionMirror, sessionLive, imgFetcher, spawnLocate, scheduler, rotation, runSync, dailyReportPath, dailyReportDir, regenerateDaily }) {
  // Host allowlist for the same-origin gate. Defaults from env; *.ts.net is always
  // accepted (Tailscale serve). Injectable for tests.
  const resolvedAllowedHosts = allowedHosts ?? readDashboardAllowedHosts(process.env.AGENT_MESH_DASHBOARD_ALLOWED_HOSTS);
  // Concierge (mobile phone front-door): ask-only chat + tap-gated issue creation.
  // Injectable for tests; defaults to a real concierge bound to this mesh root.
  const conciergeApi = concierge ?? createConcierge({ meshRoot });
  // Shared in-flight guard so concurrent POST /api/daily/refresh coalesce onto one run.
  const dailyRefresh = { fn: regenerateDaily ?? defaultRegenerateDaily, inflight: null };
  // Resolve auth token. Precedence:
  //   1. Explicit `token` arg (tests inject deterministic tokens)
  //   2. Persisted token at <meshRoot>/.agent-mesh/dashboard-token (so a CLI
  //      restart reuses the same token — old browser tabs / saved URLs keep
  //      working instead of silently 403'ing)
  //   3. Fresh random 32-byte hex, persisted to that path with 0600
  const authToken = token ?? loadOrCreatePersistedToken(meshRoot);
  let resolvedPort = port;
  let server = null;

  // In-dashboard chat (the ask-only A2A console composer and the native-session
  // input) is OFF by default — the dashboard is a read-only monitor and Claude is
  // driven from the external CLI. When an explicit consoleBroker is injected (tests
  // that exercise the console route) chat is implicitly enabled. Read-only surfaces
  // (board, tree, activity, session-log transcript/stream) are unaffected.
  const chatEnabled = !!(chat || consoleBroker);

  // The Desk console broker (ask-only A2A). Injectable for tests; defaults to a
  // real broker bound to this mesh root.
  const broker = consoleBroker ?? createConsoleBroker({ meshRoot });

  // SSE hub for /api/events change notifications.
  const autoSyncEnabled = process.env.AGENT_MESH_NO_AUTOSYNC !== '1';
  let autoSync = null;
  const sse = createSseHub({ meshRoot, pollMs: watchPollMs, onMeshChange: () => autoSync?.trigger() });
  if (autoSyncEnabled) {
    autoSync = createAutoSync({
      runSync: runSync ?? (() => doctor(meshRoot, { apply: true, managedOnly: true })),
      debounceMs: readPositiveInt(process.env.AGENT_MESH_AUTOSYNC_DEBOUNCE_MS, DEFAULT_AUTOSYNC_DEBOUNCE_MS),
      // emit-only-on-change: only push a sync event when wiring actually changed.
      onResult: (r) => {
        if (r.ok === false) { sse.emitSync({ ok: false, error: String(r.error?.code || r.error?.message || r.error), at: Date.now() }); return; }
        if (r.result?.fixed?.length) sse.emitSync({ synced: r.result.fixed, at: Date.now() });
      },
      log: (line) => process.stderr.write(`[agent-mesh] ${line}\n`)
    });
  }

  // Live mirror SSE responses (/session/:id/stream). Tracked so close() can end
  // them promptly — an active streaming response otherwise holds httpServer.close()
  // open until the keep-alive timeout.
  const mirrorStreams = new Set();

  // Native CLI launcher — only when explicitly enabled (privileged). Injectable
  // for tests; otherwise built when allowShell is set.
  const launcher = shellLauncher ?? (allowShell ? createShellLauncher({ meshRoot }) : null);
  const live = sessionLive ?? (allowShell ? createSessionLive({}) : null);

  // Dashboard-native session runner — only when explicitly enabled (privileged).
  // Injectable for tests; otherwise built when allowShell is set.
  let rotationManager = rotation ?? null;
  const runner = sessionRunner ?? (allowShell
    ? createSessionRunner({
        meshRoot, sessionLive: live,
        onTurnComplete: (info) => rotationManager?.onTurnComplete(info)
      })
    : null);
  if (!rotationManager && runner && typeof runner.runMaintenance === 'function') {
    rotationManager = createRotationManager({
      meshRoot,
      runMaintenance: runner.runMaintenance,
      runDigest,
      writeSessionId,
      readSessionId,
      recordEvent: defaultRecordEvent
    });
  }

  // Session-log index (list/transcript over CLI + dashboard transcripts) and the
  // read-only mirror. Injectable for tests; otherwise built when allowShell is set.
  const indexApi = sessionIndex ?? (allowShell
    ? {
        listSessions: (root) => defaultListSessions(root, { meshRoot }),
        resolveTranscript: (root, id) => defaultResolveTranscript(root, id, { meshRoot }),
        recordEvent: (mr, ev) => defaultRecordEvent(mr, ev),
        deleteSession: (root, id) => defaultDeleteSession(root, id, { meshRoot }),
        setLabel: (mr, id, name) => defaultSetLabel(mr, id, name),
        deleteLabel: (mr, id) => defaultDeleteLabel(mr, id),
        readLabels: (mr) => defaultReadLabels(mr)
      }
    : null);
  const mirror = sessionMirror ?? (allowShell ? createSessionMirror({}) : null);

  // Mesh scheduler — privileged (its jobs run real ask-mode delegations), so
  // it exists under the exact same gate as the shell launcher. Injectable for
  // tests; only an internally constructed scheduler is lifecycle-managed here
  // (start() on listen, stop() in close()) — an injected instance is owned by
  // the caller.
  const sched = scheduler ?? (allowShell ? createScheduler({ meshRoot }) : null);
  const schedulerOwned = !scheduler && !!sched;

  // The session-log surface is live whenever any of its backends exist.
  const sessionLogEnabled = !!(allowShell || runner || indexApi || mirror || live);

  // Image proxy fetcher — injectable for tests; when allowShell is set and no
  // injected fetcher, build the real SSRF-hardened one bound to fetchRemoteImage.
  const fetchImage = imgFetcher ?? (allowShell
    ? (url) => fetchRemoteImage(url, {
        allowHosts: ['covers.openlibrary.org', 'images-na.ssl-images-amazon.com'],
        maxBytes: 5_000_000,
        timeoutMs: 5000,
        maxRedirects: 2,
        fetchImpl: defaultPinnedFetch   // lookup defaults to dns.lookup(all) inside img-proxy
      })
    : null);

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, {
      meshRoot,
      token: authToken,
      listenerPort: resolvedPort,
      allowedHosts: resolvedAllowedHosts,
      concierge: conciergeApi,
      consoleBroker: broker,
      chatEnabled,
      sse,
      shellLauncher: launcher,
      sessionRunner: runner,
      sessionIndex: indexApi,
      sessionMirror: mirror,
      sessionLive: live,
      sessionLogEnabled,
      fetchImage,
      mirrorStreams,
      rotationManager,
      // Locate-in-Explorer action — injectable so tests record instead of spawn.
      spawnLocate: spawnLocate ?? defaultSpawnLocate,
      scheduler: sched,
      dailyReportPath,
      dailyReportDir,
      dailyRefresh,
      dashboardOwnsScheduler: schedulerOwned
    }).catch((err) => {
      applySecurityHeaders(res);
      try {
        sendText(res, 500, `Internal error: ${err.message}`);
      } catch { /* response already started */ }
    });
  });

  const start = () =>
    new Promise((resolve_, reject) => {
      httpServer.listen(port, '127.0.0.1', () => {
        const addr = httpServer.address();
        resolvedPort = addr.port;
        // Internally constructed scheduler starts ticking with the server.
        if (schedulerOwned) sched.start();
        // Fire startup sync immediately (fire-and-forget; does not delay readiness).
        if (autoSync) autoSync.runNow().catch(() => {});
        resolve_();
      });
      httpServer.once('error', reject);
    });

  const close = () =>
    // Drain any in-flight auto-sync FIRST: start() fires runNow() fire-and-forget,
    // and its doctor write would otherwise land after close() and race a caller's
    // directory cleanup (Windows ENOTEMPTY). stop() awaits the in-flight run.
    Promise.resolve(autoSync?.stop()).then(() => new Promise((resolve_, reject) => {
      // End SSE streams first: their open sockets would otherwise block
      // httpServer.close() from ever completing. This covers both the /api/events
      // hub and the live-mirror /session/:id/stream responses.
      sse.close();
      for (const r of mirrorStreams) { try { r.end(); } catch { /* already gone */ } }
      mirrorStreams.clear();
      // Free any remaining tailer state (ring buffers); watchers/intervals are
      // already released by pauseTail when the last subscriber leaves, but this
      // makes teardown explicit and complete.
      rotationManager?.stop?.();
      mirror?.close?.();
      live?.close?.();
      // Stop the internally constructed scheduler's interval timer (injected
      // schedulers are owned — and torn down — by the caller).
      if (schedulerOwned) sched.stop();
      const finish = () => { broker.close().catch(() => {}).then(resolve_); };
      if (!httpServer.listening) { finish(); return; }
      httpServer.close((err) => {
        if (err) reject(err);
        else finish();
      });
    }));

  // url is a getter so it returns the correct port after start()
  return {
    start,
    close,
    get url() {
      return `http://127.0.0.1:${resolvedPort}`;
    },
    get token() {
      return authToken;
    },
    get bootstrapUrl() {
      return `http://127.0.0.1:${resolvedPort}/?t=${authToken}`;
    }
  };
}
