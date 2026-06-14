import { MAX_TASK_CHARS } from './config.js';

export function validateDelegateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'delegate_task input must be an object.' };
  }

  const { mode, task } = input;
  if (mode !== 'ask' && mode !== 'do') {
    return { ok: false, message: 'mode must be "ask" or "do".' };
  }

  if (typeof task !== 'string' || task.length < 1 || task.length > MAX_TASK_CHARS) {
    return {
      ok: false,
      message: `task must be a string between 1 and ${MAX_TASK_CHARS} characters.`
    };
  }

  return { ok: true, value: { mode, task } };
}

export function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function mcpTextResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ]
  };
}
