export const DEFAULT_DEPTH = 3;
export const DEFAULT_FAN_OUT_MAX_PEERS = 8;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_LOG_DIR = '.agent-mesh/logs';
export const MAX_TASK_CHARS = 16_384;
// Upper bound on a single newline-delimited frame the NDJSON transports will
// buffer before a newline arrives, so a peer cannot grow the receive buffer
// without limit. Generously above MAX_TASK_CHARS to allow JSON envelope/metadata.
export const MAX_LINE_CHARS = 1_048_576;
export const MAX_DESCRIPTION_CHARS = 1200;
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
// Read-only network egress tools, granted ONLY to manifest-opted ask agents
// (see agentWantsWebTools). Never granted in `do` mode or on the digest route.
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];

export function readPositiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
