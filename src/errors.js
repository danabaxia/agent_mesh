export function badInput(message) {
  return resultError('bad_input', message);
}

export function resultError(code, message) {
  return {
    status: 'error',
    summary: '',
    files_changed: null,
    log_path: '',
    error: { code, message }
  };
}

export function refused(code, message, logPath = '') {
  return {
    status: 'refused',
    summary: '',
    files_changed: null,
    log_path: logPath,
    // Mirror the error code at the top level as `reason` for convenience —
    // callers can `result.reason === '...'` without indexing into `.error.code`.
    reason: code,
    error: { code, message }
  };
}
