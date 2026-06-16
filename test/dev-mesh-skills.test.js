// test/dev-mesh-skills.test.js — every skill a dev-mesh agent advertises in its
// card has a matching skills/<id>/SKILL.md whose frontmatter name == id (Task 5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const devMesh = join(repoRoot, 'dev-mesh');
const ROLES = ['maintainer', 'analyst', 'triager', 'coder', 'tester', 'reviewer', 'curator'];

function frontmatterName(md) {
  // Normalize CRLF: Git can check these files out with \r\n on Windows (no
  // .gitattributes), which would otherwise break the ^---\n frontmatter anchor.
  const text = String(md).replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const n = m[1].match(/^name:\s*(.+)$/m);
  return n ? n[1].trim() : null;
}

test('each agent card skill has a SKILL.md with matching frontmatter name', () => {
  for (const role of ROLES) {
    const card = JSON.parse(readFileSync(join(devMesh, role, 'agent.json'), 'utf8'));
    for (const skill of card.skills || []) {
      const p = join(devMesh, role, 'skills', skill.id, 'SKILL.md');
      assert.ok(existsSync(p), `${role}: missing skills/${skill.id}/SKILL.md`);
      const md = readFileSync(p, 'utf8');
      assert.equal(frontmatterName(md), skill.id, `${role}/${skill.id}: frontmatter name must equal the skill id`);
      assert.match(md, /^description:\s*\S/m, `${role}/${skill.id}: needs a description`);
      assert.ok(md.length > 120, `${role}/${skill.id}: SKILL.md should have a body`);
    }
  }
});

test('safety-critical skills encode the invariants', () => {
  const sec = readFileSync(join(devMesh, 'reviewer', 'skills', 'security-review', 'SKILL.md'), 'utf8');
  for (const inv of ['Anti-spoof', 'No `Bash` in `do`', 'Single writable root', 'fork PRs']) {
    assert.ok(sec.includes(inv), `security-review must mention "${inv}"`);
  }
  const cls = readFileSync(join(devMesh, 'triager', 'skills', 'classify-ci-failure', 'SKILL.md'), 'utf8');
  assert.match(cls, /infra > out-of-scope > flake > real_bug/, 'classifier precedence must be stated');
});

test('promote-to-memory SKILL.md retains the pre-push validation gate (step 2b)', () => {
  // This is the PRIMARY gate: Claude validates quick.json caps and aborts before
  // pushing. The workflow-level backstop (dev-mesh-curate.yml) only catches the case
  // where Claude skips this instruction. If step 2b is removed here, the pipeline
  // loses its early-exit and only the post-hoc backstop remains.
  const promoteMd = readFileSync(
    join(devMesh, 'curator', 'skills', 'promote-to-memory', 'SKILL.md'), 'utf8');
  assert.match(promoteMd, /validate-quick-memory\.mjs/,
    'promote-to-memory: must include the pre-push validation step (step 2b)');
  assert.match(promoteMd, /do NOT push/,
    'promote-to-memory: must instruct Claude to abort (do NOT push) on non-zero exit');
});
