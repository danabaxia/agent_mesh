/**
 * test/structure-conformance.test.js — canonical agent folder structure (design
 * spec 2026-06-10 §4). Every agent MUST carry the canonical directories even
 * when empty (.gitkeep): .agent/{memories,rules,reference,workflows,artifacts},
 * deliverables/, output/. validate FAILS on drift; doctor --apply seeds them;
 * scaffoldGaps emits .gitkeep entries so new registrations conform from birth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldGaps, CANONICAL_DIRS } from '../src/builder/scaffold.js';
import { loadSnapshot, checkConformance } from '../src/builder/conformance.js';
import { doctor } from '../src/builder/doctor.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

const AGENT_JSON = JSON.stringify({
  name: 'library', protocolVersion: '1.0', version: '0.1.0', skills: [],
  'x-agentmesh': { modes: ['ask'], meshVersion: '0.1.0' }
}) + '\n';

async function buildMesh({ withStructure = false } = {}) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'structure-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(join(agentRoot, 'prompts'), { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), AGENT_JSON, 'utf8');
  await writeFile(join(agentRoot, 'prompts', 'system.md'), '# library\n', 'utf8');
  if (withStructure) {
    for (const dir of CANONICAL_DIRS) {
      await mkdir(join(agentRoot, dir), { recursive: true });
    }
  }
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]
  });
  return { meshRoot, agentRoot };
}

test('CANONICAL_DIRS covers the locked design structure', () => {
  for (const d of ['.agent/memories', '.agent/rules', '.agent/reference',
                   '.agent/workflows', '.agent/artifacts', 'deliverables', 'output']) {
    assert.ok(CANONICAL_DIRS.includes(d), `${d} missing from CANONICAL_DIRS`);
  }
});

test('scaffoldGaps emits .gitkeep for every missing canonical dir', () => {
  const gaps = scaffoldGaps({ existingDirs: ['.agent/memories'] }, { name: 'x', modes: ['ask'] });
  const paths = gaps.map((g) => g.path);
  assert.ok(!paths.includes('.agent/memories/.gitkeep'), 'existing dir must not be re-emitted');
  for (const d of CANONICAL_DIRS.filter((d) => d !== '.agent/memories')) {
    assert.ok(paths.includes(`${d}/.gitkeep`), `${d}/.gitkeep not emitted`);
  }
});

test('validate FAILS an agent that drifts from the canonical structure', async () => {
  const { meshRoot } = await buildMesh({ withStructure: false });
  const report = checkConformance(await loadSnapshot(meshRoot));
  const fails = report.rules.filter((r) => r.rule === 'structure' && r.level === 'fail');
  assert.ok(fails.length >= CANONICAL_DIRS.length, `expected a fail per missing dir, got ${fails.length}`);
  assert.equal(report.ok, false);
});

test('validate PASSES when the canonical structure is present (even empty)', async () => {
  const { meshRoot } = await buildMesh({ withStructure: true });
  const report = checkConformance(await loadSnapshot(meshRoot));
  const structureRules = report.rules.filter((r) => r.rule === 'structure');
  assert.ok(structureRules.length > 0, 'structure rule must be evaluated');
  assert.ok(structureRules.every((r) => r.level === 'pass'), JSON.stringify(structureRules));
});

test('tools rule: external stdio declarations (absolute/non-tools paths) are not dangling', async () => {
  // An agent may declare an EXTERNAL stdio server (e.g. a python MCP outside the
  // folder) — the mesh passes it verbatim; only in-folder tools/<x>/server.mjs
  // declarations must resolve to a file.
  const { meshRoot, agentRoot } = await buildMesh({ withStructure: true });
  await writeFile(join(agentRoot, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'tester-control': { type: 'stdio', command: 'python', args: ['C:/AI/MCP/tester_control/server.py'] }
    }
  }) + '\n', 'utf8');
  const report = checkConformance(await loadSnapshot(meshRoot));
  const toolFails = report.rules.filter((r) => r.rule === 'tools' && r.level === 'fail');
  assert.deepEqual(toolFails, [], JSON.stringify(toolFails));
});

test('doctor --apply seeds the missing canonical dirs with .gitkeep', async () => {
  const { meshRoot, agentRoot } = await buildMesh({ withStructure: false });
  await doctor(meshRoot, { apply: true });
  for (const dir of CANONICAL_DIRS) {
    await access(join(agentRoot, dir, '.gitkeep')); // throws if missing
  }
  const report = checkConformance(await loadSnapshot(meshRoot));
  assert.ok(report.rules.filter((r) => r.rule === 'structure').every((r) => r.level === 'pass'));
});
