// src/board/store.js — thin fs shell for the mesh task board.
// One JSON file per task at <meshRoot>/mesh/board/tasks/<id>.json. Writes are
// atomic (temp + rename) so a reader (hook / verb) never sees a torn file.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../atomic-write.js';
import { STATES } from './task-state.js';

export function boardDir(meshRoot) {
  return join(meshRoot, 'mesh', 'board', 'tasks');
}

function slug(name) {
  return String(name).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

async function existingIds(meshRoot) {
  try {
    const files = await readdir(boardDir(meshRoot));
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// Next free <from>-<to>-NNN id (zero-padded, 3 digits). Scans existing files so
// the counter survives restarts and is collision-free per pair.
export async function nextTaskId(meshRoot, from, to) {
  const prefix = `${slug(from)}-${slug(to)}-`;
  const ids = await existingIds(meshRoot);
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number.parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function atomicWriteJson(path, obj) {
  return atomicWriteFile(path, JSON.stringify(obj, null, 2) + '\n', { mode: 0o644 });
}

export async function createTask(meshRoot, { from, to, title, objective, context = '', requirements, pointers = '', at }) {
  await mkdir(boardDir(meshRoot), { recursive: true });
  const id = await nextTaskId(meshRoot, from, to);
  const task = {
    id, from, to, title, objective, context, requirements, pointers,
    state: STATES.ASSIGNED,
    created_at: at,
    result: null,
    seen_by_from: false,
    history: [{ state: STATES.ASSIGNED, at, by: from }]
  };
  await atomicWriteJson(join(boardDir(meshRoot), `${id}.json`), task);
  return task;
}

export async function readTask(meshRoot, id) {
  try {
    return JSON.parse(await readFile(join(boardDir(meshRoot), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function listTasks(meshRoot) {
  const ids = await existingIds(meshRoot);
  const tasks = await Promise.all(ids.map((id) => readTask(meshRoot, id)));
  return tasks.filter(Boolean);
}

export async function writeTask(meshRoot, task) {
  await mkdir(boardDir(meshRoot), { recursive: true });
  await atomicWriteJson(join(boardDir(meshRoot), `${task.id}.json`), task);
  return task;
}

export async function markSeenByFrom(meshRoot, id) {
  const task = await readTask(meshRoot, id);
  if (!task || task.seen_by_from === true) return task;
  return writeTask(meshRoot, { ...task, seen_by_from: true });
}
