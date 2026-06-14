// src/atomic-write.js — temp-file + atomic rename writer (the persistEpoch
// pattern, extracted per spec 2026-06-12 §5.3 so digest apply and the epoch
// store share one implementation). A torn write can never be observed.
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function atomicWriteFile(path, content, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, path);
}
