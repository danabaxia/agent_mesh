/**
 * src/dashboard/resume-command.js — PURE. Build the copy-paste command that
 * replaces the terminal launcher (2026-06-13 spec §5). Inputs are framework-
 * validated upstream (manifest-resolved root, UUID id); quoting here is
 * defense in depth, not the security boundary. Always an exact id
 * (--resume/--session-id), never `--continue` (recency heuristic — CLAUDE.md).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function buildResumeCommand({ agentRoot, sessionId = null, mode, platform = process.platform }) {
  if (mode !== 'new') {
    if (!UUID_RE.test(String(sessionId))) throw Object.assign(new Error('bad session id'), { code: 'bad_id' });
  }
  const claude = mode === 'new' ? 'claude'
    : mode === 'seed' ? `claude --session-id ${sessionId}`
    : `claude --resume ${sessionId}`;
  if (platform === 'win32') {
    return { shell: 'powershell', cwd: agentRoot, command: `cd ${psQuote(agentRoot)}; ${claude}` };
  }
  return { shell: 'sh', cwd: agentRoot, command: `cd ${shQuote(agentRoot)} && ${claude}` };
}
