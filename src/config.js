export const DEFAULT_DEPTH = 3;
export const DEFAULT_FAN_OUT_MAX_PEERS = 8;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_LOG_DIR = '.agent-mesh/logs';
export const MAX_TASK_CHARS = 16_384;
// Upper bound on a single newline-delimited frame the NDJSON transports will
// buffer before a newline arrives, so a peer cannot grow the receive buffer
// without limit. Generously above MAX_TASK_CHARS to allow JSON envelope/metadata.
export const MAX_LINE_CHARS = 1_048_576;
// Upper bound retained per child stdout/stderr stream. Final logs already store
// tails; bounding the live buffer prevents a noisy child from exhausting memory.
export const MAX_CHILD_OUTPUT_CHARS = 1_048_576;
export const MAX_DESCRIPTION_CHARS = 1200;
// Below this normalized length an AGENT.md is too thin to route on (issue #184):
// readAgentDescription supplements/replaces it with an auto-harvested [auto]
// fingerprint (package.json + top-level dir listing) so list_peers stays useful.
export const MIN_AGENT_MD_CHARS = 80;
export const MAX_PROMPT_CHARS = 8_000;
// Per-memory-file cap inside the assembled runtime prompt. Memory sections come
// before the mode prompt and skills, so an uncapped runaway memory file could
// consume the whole MAX_PROMPT_CHARS budget and starve later sections.
export const MAX_MEMORY_FILE_CHARS = 2_000;

// Session-generations knobs (spec 2026-06-12). CONTEXT_WINDOW must be overridden
// for 1M-context models; ROTATE_HEADROOM_PCT of '0' disables auto-rotation.
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_ROTATE_HEADROOM_PCT = 25;
export const DEFAULT_ROTATE_IDLE_MS = 120_000;
export const DEFAULT_DIGEST_TIMEOUT_MS = 180_000;
export const DEFAULT_DIGEST_EXTRACT_MAX_CHARS = 120_000;
export const MAX_DECISIONS_INDEX_LINES = 30;

// Managed-wiring auto-sync (spec 2026-06-13): debounce window for watcher-driven
// doctor managedOnly applies. AGENT_MESH_NO_AUTOSYNC=1 disables auto-sync.
export const DEFAULT_AUTOSYNC_DEBOUNCE_MS = 2000;

// Mesh-level heartbeat (dev-society daemon, Phase 3). AGENT_MESH_HEARTBEAT_INTERVAL_MS=0 disables.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 300_000;       // 5m mesh-health tick (0 disables)
export const DEFAULT_HEARTBEAT_FAIL_THRESHOLD = 3;          // consecutive fails → failing
export const DEFAULT_HEARTBEAT_OVERDUE_GRACE_MS = 900_000;  // 15m past nextRunAt → overdue
export const DEFAULT_HEARTBEAT_STALE_MS = 1_800_000;        // 30m running → stuck
export const DEFAULT_HEARTBEAT_ESCALATE_AFTER = 2;          // heartbeats a finding must persist before a GH issue

export const DEFAULT_ACTIVITY_KEEP_DAYS = 30;   // prune activity-*.jsonl older than this
export const MAX_ACTIVITY_SUMMARY = 240;        // activity event summary char cap

export const MAX_FAN_OUT_PEERS = 10;

export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Per-peer extended thinking effort (issue #530). Registry-only — the model cannot
// set this through tool arguments. "low" is the explicit suppression form.
export const VALID_THINKING_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Read-only network egress tools, granted ONLY to manifest-opted ask agents
// (see agentWantsWebTools). Never granted in `do` mode or on the digest route.
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];

// Dashboard host allowlist (spec 2026-06-21 mesh-mobile-concierge). The dashboard
// stays bound to 127.0.0.1; Tailscale `serve` proxies the tailnet to localhost, so
// proxied requests arrive with a MagicDNS Host header. The same-origin gate accepts
// *.ts.net hosts automatically (tailnet membership + the dashboard token are the
// real gate) plus any hostnames explicitly listed here. Never a wildcard; the token
// is still required on every gated route.
export function readDashboardAllowedHosts(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function readPositiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Mobile Concierge history persistence (issue #362). AGENT_MESH_CONCIERGE_HISTORY_MAX turns
// are kept on disk; AGENT_MESH_CONCIERGE_CONTEXT_TURNS are injected into each model prompt.
export const DEFAULT_CONCIERGE_HISTORY_MAX = 200;
export const DEFAULT_CONCIERGE_CONTEXT_TURNS = 10;

// Mesh Improvement Report (MIR) — spec 2026-06-19. All optional; see CLAUDE.md Config.
export const DEFAULT_MIR_DIR = '.dev-society/mir';
export const DEFAULT_MIR_NOISE_BAND_PCT = 10;   // soft-finding regression threshold (%)
export const DEFAULT_MIR_RECOVER_RUNS = 2;       // consecutive clean runs before an issue closes
export const DEFAULT_MIR_TREND_N = 10;           // trend-history length + ledger GC bound
export const DEFAULT_MESH_SCAN_LABEL = 'generated:mesh-scan';
// finding.id controlled vocabulary — becomes a label/marker, so it must be injection-safe.
export const MIR_ID_RE = /^[a-z0-9:_-]+$/;

// Task-board stale detection (mesh-health list_stale_tasks verb).
// A non-terminal task whose last history transition is older than this is surfaced as stale.
export const DEFAULT_BOARD_STALE_MS = 86_400_000; // 24 h

// Health "Vital Signs" dashboard view — spec 2026-06-21. All optional; powers the
// read-only passive health model (src/dashboard/health-model.js). See CLAUDE.md Config.
export const DEFAULT_HEALTH_AGENT_STALE_MS = 3_600_000;   // 1h since last activity → stale/idle band
export const DEFAULT_HEALTH_AGENT_DEAD_MS = 86_400_000;   // 24h silence + a known cadence → dead mechanism
export const DEFAULT_HEALTH_DAEMON_STALE_MS = 900_000;    // 15m daemon-log silence → daemon heart stopped
export const DEFAULT_HEALTH_PROMPT_SOFT_BYTES = 16_384;   // per-agent prompt soft size → cognition flag
export const DEFAULT_HEALTH_HEADROOM_WARN_PCT = 25;       // context headroom below this → cognition flag
export const DEFAULT_HEALTH_HISTORY_DAYS = 14;            // activity-history sparkline window (days)

// Proactive health-alert sweep (dev-society daemon) — issue #361. Consumes the
// organ-level health model and files a `needs-human` issue when an organ goes
// CRITICAL, auto-closing on recovery. AGENT_MESH_HEALTH_ALERT_INTERVAL_MS=0 (or
// AGENT_MESH_HEALTH_ALERT_DISABLED) disables. See CLAUDE.md Config.
export const DEFAULT_HEALTH_ALERT_INTERVAL_MS = 900_000;  // 15m health-alert tick (0 disables)

// Inspiration digest (dev-society daemon, mesh-aware ideation partner).
// AGENT_MESH_INSPIRATION_FILE: where the digest JSON is written.
// AGENT_MESH_INSPIRATION_INTERVAL_MS: how often the daemon re-runs the digest (daily default).
// AGENT_MESH_INSPIRATION_MAX_SEEDS: cap on seeds emitted per run.
// AGENT_MESH_INSPIRATION_STALE_MS: how old a signal must be before it's considered degraded.
export const DEFAULT_INSPIRATION_FILE_SUFFIX = '.dev-society/inspiration.json'; // resolved under mesh-root
export const DEFAULT_INSPIRATION_INTERVAL_MS = 86_400_000;  // 24h
export const DEFAULT_INSPIRATION_MAX_SEEDS = 7;
export const DEFAULT_INSPIRATION_STALE_MS = 172_800_000;   // 48h

// resolveInspirationConfig: pure resolver for the inspiration-digest builtin.
// `joinPath` is injected so this file stays import-free (matching the rest of config.js).
export function resolveInspirationConfig(env = {}, meshRoot = '', joinPath = (a, b) => `${a}/${b}`) {
  return {
    file: env.AGENT_MESH_INSPIRATION_FILE || (meshRoot ? joinPath(meshRoot, DEFAULT_INSPIRATION_FILE_SUFFIX) : DEFAULT_INSPIRATION_FILE_SUFFIX),
    intervalMs: readPositiveInt(env.AGENT_MESH_INSPIRATION_INTERVAL_MS, DEFAULT_INSPIRATION_INTERVAL_MS),
    maxSeeds: readPositiveInt(env.AGENT_MESH_INSPIRATION_MAX_SEEDS, DEFAULT_INSPIRATION_MAX_SEEDS),
    staleMs: readPositiveInt(env.AGENT_MESH_INSPIRATION_STALE_MS, DEFAULT_INSPIRATION_STALE_MS),
  };
}

// Resolve the health thresholds from an env-like bag, falling back to the defaults
// above. Pure: no process access of its own. Used by health-collect + /api/health.
export function resolveHealthThresholds(env = {}) {
  return {
    agentStaleMs: readPositiveInt(env.AGENT_MESH_HEALTH_AGENT_STALE_MS, DEFAULT_HEALTH_AGENT_STALE_MS),
    agentDeadMs: readPositiveInt(env.AGENT_MESH_HEALTH_AGENT_DEAD_MS, DEFAULT_HEALTH_AGENT_DEAD_MS),
    daemonStaleMs: readPositiveInt(env.AGENT_MESH_HEALTH_DAEMON_STALE_MS, DEFAULT_HEALTH_DAEMON_STALE_MS),
    promptSoftBytes: readPositiveInt(env.AGENT_MESH_HEALTH_PROMPT_SOFT_BYTES, DEFAULT_HEALTH_PROMPT_SOFT_BYTES),
    headroomWarnPct: readPositiveInt(env.AGENT_MESH_HEALTH_HEADROOM_WARN_PCT, DEFAULT_HEALTH_HEADROOM_WARN_PCT),
    historyDays: readPositiveInt(env.AGENT_MESH_HEALTH_HISTORY_DAYS, DEFAULT_HEALTH_HISTORY_DAYS),
  };
}
