export const DEFAULT_DEPTH = 3;
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

export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];

export function readPositiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
