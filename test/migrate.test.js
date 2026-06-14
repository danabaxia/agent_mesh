/**
 * test/migrate.test.js
 *
 * Tests for src/builder/migrate.js — copy/migration policy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, writeFile, mkdir, readFile, symlink, readdir
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { copyInto } from '../src/builder/migrate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeSrc(files) {
  const src = await mkdtemp(join(tmpdir(), 'migrate-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(src, rel);
    await mkdir(join(full, '..'), { recursive: true });
    if (content === null) {
      // make it a directory
      await mkdir(full, { recursive: true });
    } else {
      await writeFile(full, content, 'utf8');
    }
  }
  return src;
}

// ---------------------------------------------------------------------------
// Basic copy
// ---------------------------------------------------------------------------

test('copyInto: copies regular files into destDir', async () => {
  const src = await makeSrc({ 'hello.txt': 'hello', 'sub/world.txt': 'world' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  // dest must be empty for non-force
  const emptyDest = join(dest, 'target');
  await mkdir(emptyDest, { recursive: true });

  const result = await copyInto(src, emptyDest, {});

  const hello = await readFile(join(emptyDest, 'hello.txt'), 'utf8');
  assert.equal(hello, 'hello');
  const world = await readFile(join(emptyDest, 'sub', 'world.txt'), 'utf8');
  assert.equal(world, 'world');
  assert.ok(result.copied.some(p => p.includes('hello.txt')));
  assert.ok(result.copied.some(p => p.includes('world.txt')));
});

// ---------------------------------------------------------------------------
// Safety denylist — never copied even without --include-ignored
// ---------------------------------------------------------------------------

test('copyInto: never copies .git/ directory', async () => {
  const src = await makeSrc({ 'code.js': 'x', '.git/HEAD': 'ref: refs/heads/main' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  const result = await copyInto(src, target, {});

  // .git should not appear in dest
  let err;
  try { await readFile(join(target, '.git', 'HEAD'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, '.git must not be copied');
  assert.ok(result.skipped.some(s => s.includes('.git') || s === '.git'), `.git should be in skipped: ${JSON.stringify(result.skipped)}`);
});

test('copyInto: never copies .env files', async () => {
  const src = await makeSrc({ 'index.js': 'x', '.env': 'SECRET=1', '.env.local': 'X=2' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err1, err2;
  try { await readFile(join(target, '.env'), 'utf8'); } catch (e) { err1 = e; }
  try { await readFile(join(target, '.env.local'), 'utf8'); } catch (e) { err2 = e; }
  assert.ok(err1, '.env must not be copied');
  assert.ok(err2, '.env.local must not be copied');
});

test('copyInto: never copies node_modules/', async () => {
  const src = await makeSrc({ 'index.js': 'x', 'node_modules/some-pkg/index.js': 'pkg' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err;
  try { await readFile(join(target, 'node_modules', 'some-pkg', 'index.js'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, 'node_modules must not be copied');
});

test('copyInto: never copies *.pem files', async () => {
  const src = await makeSrc({ 'cert.pem': 'BEGIN CERT', 'app.js': 'x' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err;
  try { await readFile(join(target, 'cert.pem'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, '*.pem must not be copied');
});

test('copyInto: never copies *.key files', async () => {
  const src = await makeSrc({ 'private.key': 'BEGIN KEY', 'code.js': 'x' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err;
  try { await readFile(join(target, 'private.key'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, '*.key must not be copied');
});

test('copyInto: never copies id_rsa files', async () => {
  const src = await makeSrc({ 'id_rsa': 'BEGIN RSA', 'id_rsa.pub': 'ssh-rsa', 'app.js': 'x' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err;
  try { await readFile(join(target, 'id_rsa'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, 'id_rsa must not be copied');
});

test('copyInto: never copies *secret* files', async () => {
  const src = await makeSrc({ 'my_secret_key.json': '{}', 'credentials.json': '{}', 'app.js': 'x' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err1, err2;
  try { await readFile(join(target, 'my_secret_key.json'), 'utf8'); } catch (e) { err1 = e; }
  try { await readFile(join(target, 'credentials.json'), 'utf8'); } catch (e) { err2 = e; }
  assert.ok(err1, '*secret* must not be copied');
  assert.ok(err2, '*credential* must not be copied');
});

test('copyInto: never copies dist/ or build/ or out/ directories', async () => {
  const src = await makeSrc({
    'src/index.js': 'x',
    'dist/bundle.js': 'bundled',
    'build/out.js': 'built',
    'out/result.js': 'output'
  });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let e1, e2, e3;
  try { await readFile(join(target, 'dist', 'bundle.js'), 'utf8'); } catch (e) { e1 = e; }
  try { await readFile(join(target, 'build', 'out.js'), 'utf8'); } catch (e) { e2 = e; }
  try { await readFile(join(target, 'out', 'result.js'), 'utf8'); } catch (e) { e3 = e; }
  assert.ok(e1, 'dist/ must not be copied');
  assert.ok(e2, 'build/ must not be copied');
  assert.ok(e3, 'out/ must not be copied');
});

test('copyInto: never copies .DS_Store', async () => {
  const src = await makeSrc({ '.DS_Store': 'mac garbage', 'code.js': 'x' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  await copyInto(src, target, {});

  let err;
  try { await readFile(join(target, '.DS_Store'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, '.DS_Store must not be copied');
});

// ---------------------------------------------------------------------------
// .gitignore tier — skipped by default
// ---------------------------------------------------------------------------

test('copyInto: skips .gitignore-listed top-level patterns by default', async () => {
  const src = await makeSrc({ 'logs/app.log': 'log', 'src/index.js': 'x', '.gitignore': 'logs/\n' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  const result = await copyInto(src, target, {});

  let err;
  try { await readFile(join(target, 'logs', 'app.log'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, 'gitignore-listed paths should be skipped by default');

  // src/index.js should be copied
  const code = await readFile(join(target, 'src', 'index.js'), 'utf8');
  assert.equal(code, 'x');
});

// ---------------------------------------------------------------------------
// Symlinks — skipped with warning by default
// ---------------------------------------------------------------------------

test('copyInto: skips symlinks by default and records them in skipped', async () => {
  const src = await mkdtemp(join(tmpdir(), 'migrate-sym-'));
  await writeFile(join(src, 'real.txt'), 'real content');
  // Create a symlink pointing to real.txt
  await symlink('real.txt', join(src, 'link.txt'));

  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  const result = await copyInto(src, target, {});

  // real.txt should be copied
  const real = await readFile(join(target, 'real.txt'), 'utf8');
  assert.equal(real, 'real content');

  // link.txt should NOT be copied
  let err;
  try { await readFile(join(target, 'link.txt'), 'utf8'); } catch (e) { err = e; }
  assert.ok(err, 'symlink should be skipped by default');

  // link.txt should be in skipped
  assert.ok(result.skipped.some(s => s.includes('link.txt')), `symlink must appear in skipped: ${JSON.stringify(result.skipped)}`);
});

// ---------------------------------------------------------------------------
// Collision — throws without force
// ---------------------------------------------------------------------------

test('copyInto: throws on non-empty dest without force', async () => {
  const src = await makeSrc({ 'hello.txt': 'hello' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);
  // Put a file in dest to make it non-empty
  await writeFile(join(target, 'existing.txt'), 'existing');

  await assert.rejects(
    () => copyInto(src, target, {}),
    (err) => {
      assert.ok(
        err.message.toLowerCase().includes('collision') ||
        err.message.toLowerCase().includes('non-empty') ||
        err.message.toLowerCase().includes('exists') ||
        err.message.toLowerCase().includes('force'),
        `Expected collision error, got: ${err.message}`
      );
      return true;
    }
  );
});

test('copyInto: succeeds on non-empty dest with force', async () => {
  const src = await makeSrc({ 'hello.txt': 'hello' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);
  await writeFile(join(target, 'existing.txt'), 'existing');

  // Should not throw
  const result = await copyInto(src, target, { force: true });
  const hello = await readFile(join(target, 'hello.txt'), 'utf8');
  assert.equal(hello, 'hello');
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

test('copyInto: returns { copied, skipped } arrays', async () => {
  const src = await makeSrc({ 'a.txt': 'a', '.git/HEAD': 'ref' });
  const dest = await mkdtemp(join(tmpdir(), 'migrate-dest-'));
  const target = join(dest, 'agent');
  await mkdir(target);

  const result = await copyInto(src, target, {});
  assert.ok(Array.isArray(result.copied), 'copied must be an array');
  assert.ok(Array.isArray(result.skipped), 'skipped must be an array');
});
