/**
 * test/artifact-routes.test.js — POST + GET /api/agent/:name/artifacts
 * (save a result with captured task context into .agent/artifacts/<id>/,
 * list saved artifacts newest-first).
 *
 * Harness mirrors test/deliverables-routes.test.js: temp mesh + library agent,
 * token-boot → cookie auth, same-origin fetch helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'artroutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot };
}

// Fixture deliverable referenced by the file-source save test.
async function seedDeliverables(agentRoot) {
  const task = join(agentRoot, 'deliverables', '2026-06-11', 'sample-task');
  await mkdir(task, { recursive: true });
  await writeFile(join(task, 'report.md'), '# hello', 'utf8');
}

async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
const post = (srv, port, cookie, p, body) => fetch(`${srv.url}${p}`, {
  method: 'POST',
  headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body)
});
const del = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, {
  method: 'DELETE',
  headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
});
const exists = (p) => stat(p).then(() => true, () => false);

// Contract body per the Phase-3 plan (LOCKED storage contract).
const textBody = () => ({
  title: 'Root cause — SN 100000000000',
  type: 'report',
  task: 'root-cause failed SN',
  inputs: ['SN'],
  frame: ['ENABLE lookup', 'screenlog triage', 'source trace', 'verdict'],
  source: { kind: 'text', content: 'hello' }
});

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+$/;

test('artifact save: text source → 201, id format, context.json round-trips, artifact.md embeds', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/artifacts', textBody());
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.match(body.id, ID_RE);

    const dir = join(agentRoot, '.agent', 'artifacts', body.id);
    const ctx = JSON.parse(await readFile(join(dir, 'context.json'), 'utf8'));
    assert.equal(ctx.title, 'Root cause — SN 100000000000');
    assert.equal(ctx.type, 'report');
    assert.equal(ctx.task, 'root-cause failed SN');
    assert.deepEqual(ctx.frame, ['ENABLE lookup', 'screenlog triage', 'source trace', 'verdict']);
    assert.deepEqual(ctx.inputs, ['SN']);
    assert.equal(ctx.agent, 'library');
    assert.equal(ctx.promotedTo, null);
    assert.ok(!Number.isNaN(Date.parse(ctx.savedAt)), 'savedAt is ISO parseable');
    assert.equal(ctx.source.kind, 'text');

    const md = await readFile(join(dir, 'artifact.md'), 'utf8');
    assert.ok(md.startsWith('# '), 'artifact.md starts with # title');
    assert.match(md, /hello/, 'text content ≤64KB is embedded');
  } finally { await srv.close(); }
});

test('artifact save: file source → 201, artifact.md points at the deliverable path', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  await seedDeliverables(agentRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/artifacts', {
      title: 'Phase2 demo summary', type: 'report', task: 'demo',
      source: { kind: 'file', path: '2026-06-11/sample-task/report.md' }
    });
    assert.equal(r.status, 201);
    const { id } = await r.json();
    const dir = join(agentRoot, '.agent', 'artifacts', id);
    const ctx = JSON.parse(await readFile(join(dir, 'context.json'), 'utf8'));
    assert.equal(ctx.source.kind, 'file');
    assert.equal(ctx.source.path, '2026-06-11/sample-task/report.md');
    const md = await readFile(join(dir, 'artifact.md'), 'utf8');
    assert.ok(md.startsWith('# '), 'artifact.md starts with # title');
    assert.match(md, /2026-06-11\/sample-task\/report\.md/, 'pointer line carries the path');
  } finally { await srv.close(); }
});

test('artifact save: missing/empty title or bad type → 400; unknown agent → 404', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const noTitle = { ...textBody() }; delete noTitle.title;
    assert.equal((await post(srv, port, cookie, '/api/agent/library/artifacts', noTitle)).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/artifacts', { ...textBody(), title: '   ' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/artifacts', { ...textBody(), type: 'poem' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/no-such-agent/artifacts', textBody())).status, 404);
  } finally { await srv.close(); }
});

test('artifact save: id collision in the same minute → -2 / -3 suffix', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const first = await (await post(srv, port, cookie, '/api/agent/library/artifacts', textBody())).json();
    const second = await (await post(srv, port, cookie, '/api/agent/library/artifacts', textBody())).json();
    const third = await (await post(srv, port, cookie, '/api/agent/library/artifacts', textBody())).json();
    assert.equal(second.id, `${first.id}-2`);
    assert.equal(third.id, `${first.id}-3`);
    const dirs = await readdir(join(agentRoot, '.agent', 'artifacts'));
    assert.equal(dirs.length, 3);
  } finally { await srv.close(); }
});

test('artifact save: slug is lowercase alnum, collapsed, trimmed, ≤40 chars', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await post(srv, port, cookie, '/api/agent/library/artifacts', {
      ...textBody(), title: '  ** Très LONG title!! with — weird *** chars & padding to exceed forty characters easily **  '
    });
    assert.equal(r.status, 201);
    const { id } = await r.json();
    const slug = id.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '');
    assert.ok(slug.length <= 40, `slug ≤40 chars (got ${slug.length})`);
    assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase alnum, single hyphens, no leading/trailing hyphen');
  } finally { await srv.close(); }
});

test('artifact list: newest-first by savedAt with listed fields; unparseable context.json skipped', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  // Seed directly on disk with controlled savedAt values + one broken entry.
  const root = join(agentRoot, '.agent', 'artifacts');
  const seed = async (id, ctx) => {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, 'context.json'), JSON.stringify(ctx), 'utf8');
    await writeFile(join(root, id, 'artifact.md'), `# ${ctx.title}\n`, 'utf8');
  };
  await seed('2026-06-10-0900-older', {
    title: 'Older', type: 'table', task: 'old task', inputs: [], frame: [],
    source: { kind: 'text', content: 'a' }, agent: 'library',
    savedAt: '2026-06-10T09:00:00.000Z', sessionId: null, promotedTo: null
  });
  await seed('2026-06-11-0800-newer', {
    title: 'Newer', type: 'report', task: 'new task', inputs: [], frame: [],
    source: { kind: 'file', path: '2026-06-11/sample-task/report.md' }, agent: 'library',
    savedAt: '2026-06-11T08:00:00.000Z', sessionId: null, promotedTo: null
  });
  await mkdir(join(root, '2026-06-09-0700-broken'), { recursive: true });
  await writeFile(join(root, '2026-06-09-0700-broken', 'context.json'), '{not json', 'utf8');

  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/artifacts');
    assert.equal(r.status, 200);
    const { artifacts } = await r.json();
    assert.equal(artifacts.length, 2, 'broken entry skipped');
    assert.deepEqual(artifacts.map((a) => a.id), ['2026-06-11-0800-newer', '2026-06-10-0900-older']);
    const a = artifacts[0];
    assert.equal(a.title, 'Newer');
    assert.equal(a.type, 'report');
    assert.equal(a.task, 'new task');
    assert.equal(a.savedAt, '2026-06-11T08:00:00.000Z');
    assert.equal(a.promotedTo, null);
    assert.deepEqual(a.source, { kind: 'file', path: '2026-06-11/sample-task/report.md' });
  } finally { await srv.close(); }
});

test('artifact list: unknown agent → 404; no .agent/artifacts dir → 200 empty', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/agent/no-such-agent/artifacts')).status, 404);
    const r = await get(srv, port, cookie, '/api/agent/library/artifacts');
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).artifacts, []);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------------------
// Task 2: artifact delete + workflow promote/list/delete
// ---------------------------------------------------------------------------

test('artifact delete: 200 + dir gone; second delete → 404', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const { id } = await (await post(srv, port, cookie, '/api/agent/library/artifacts', textBody())).json();
    const dir = join(agentRoot, '.agent', 'artifacts', id);
    assert.equal(await exists(dir), true);

    const r = await del(srv, port, cookie, `/api/agent/library/artifact/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(await exists(dir), false, 'artifact dir removed');

    assert.equal((await del(srv, port, cookie, `/api/agent/library/artifact/${id}`)).status, 404);
  } finally { await srv.close(); }
});

test('artifact delete: bad id chars / embedded .. → 400; valid-but-missing → 404; unknown agent → 404', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await del(srv, port, cookie, '/api/agent/library/artifact/bad%24id')).status, 400);
    assert.equal((await del(srv, port, cookie, '/api/agent/library/artifact/.hidden')).status, 400);
    // A pure '..' segment (%2e%2e) is collapsed by WHATWG URL normalization
    // BEFORE routing — the path becomes /api/agent/library/ and never reaches
    // the artifact route, so the traversal is neutralized upstream (404, not
    // 400). Embedded dots ('a..b') survive normalization and must hit our
    // validator.
    assert.equal((await del(srv, port, cookie, '/api/agent/library/artifact/%2e%2e')).status, 404);
    assert.equal((await del(srv, port, cookie, '/api/agent/library/artifact/a%2e%2eb')).status, 400, 'embedded .. rejected');
    assert.equal((await del(srv, port, cookie, '/api/agent/library/artifact/2026-06-11-0900-nope')).status, 404);
    assert.equal((await del(srv, port, cookie, '/api/agent/no-such-agent/artifact/2026-06-11-0900-x')).status, 404);
  } finally { await srv.close(); }
});

test('artifact delete: dir without context.json → 403, dir survives', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const planted = join(agentRoot, '.agent', 'artifacts', 'not-an-artifact');
  await mkdir(planted, { recursive: true });
  await writeFile(join(planted, 'notes.txt'), 'precious', 'utf8');
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await del(srv, port, cookie, '/api/agent/library/artifact/not-an-artifact');
    assert.equal(r.status, 403);
    assert.equal(await exists(join(planted, 'notes.txt')), true, 'non-artifact dir untouched');
  } finally { await srv.close(); }
});

test('workflow promote: fromArtifact → 201 slug, .md frontmatter, artifact promotedTo updated', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const { id } = await (await post(srv, port, cookie, '/api/agent/library/artifacts', textBody())).json();

    const r = await post(srv, port, cookie, '/api/agent/library/workflows', { fromArtifact: id });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.match(body.slug, /^[a-z0-9][a-z0-9-]*$/);

    const md = await readFile(join(agentRoot, '.agent', 'workflows', `${body.slug}.md`), 'utf8');
    assert.ok(md.startsWith('---\n'), 'frontmatter opens the file');
    assert.match(md, new RegExp(`^name: ${body.slug}$`, 'm'));
    assert.match(md, /^title: Root cause — SN 100000000000$/m);
    assert.match(md, /^inputs: \["SN"\]$/m);
    assert.match(md, new RegExp(`^promoted_from: ${id}$`, 'm'));
    assert.match(md, /^created: \d{4}-\d{2}-\d{2}$/m);
    assert.match(md, /# Decision frame\n1\. ENABLE lookup\n2\. screenlog triage\n3\. source trace\n4\. verdict/);

    const ctx = JSON.parse(await readFile(join(agentRoot, '.agent', 'artifacts', id, 'context.json'), 'utf8'));
    assert.equal(ctx.promotedTo, body.slug);
  } finally { await srv.close(); }
});

test('workflow create: direct body → 201; missing title+fromArtifact → 400; fromArtifact missing → 404; slug collision → -2', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r1 = await post(srv, port, cookie, '/api/agent/library/workflows', {
      title: 'Daily drift check', inputs: ['station'], frame: ['query NTP offset', 'compare to limit']
    });
    assert.equal(r1.status, 201);
    const { slug } = await r1.json();
    assert.equal(slug, 'daily-drift-check');
    const md = await readFile(join(agentRoot, '.agent', 'workflows', `${slug}.md`), 'utf8');
    assert.match(md, /^promoted_from: $/m, 'no artifact linkage on direct creation');
    assert.match(md, /1\. query NTP offset\n2\. compare to limit/);

    const r2 = await post(srv, port, cookie, '/api/agent/library/workflows', { title: 'Daily drift check' });
    assert.equal(r2.status, 201);
    assert.equal((await r2.json()).slug, 'daily-drift-check-2');

    assert.equal((await post(srv, port, cookie, '/api/agent/library/workflows', { inputs: ['x'] })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/workflows', { fromArtifact: '2026-06-11-0900-nope' })).status, 404);
    assert.equal((await post(srv, port, cookie, '/api/agent/library/workflows', { fromArtifact: 'a..b' })).status, 400);
    assert.equal((await post(srv, port, cookie, '/api/agent/no-such-agent/workflows', { title: 'x' })).status, 404);
  } finally { await srv.close(); }
});

test('workflow create: explicit title/purpose/inputs/frame override artifact-derived values; purpose round-trips', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const { id } = await (await post(srv, port, cookie, '/api/agent/library/artifacts', textBody())).json();
    const r = await post(srv, port, cookie, '/api/agent/library/workflows', {
      fromArtifact: id,
      title: 'Root-cause a failed SN',
      purpose: 'Trace a failed serial number to a script/framework/hardware verdict with citations.',
      inputs: ['SN', 'run'],
      frame: ['ENABLE lookup', 'screenlog triage', 'verdict']
    });
    assert.equal(r.status, 201);
    const { slug } = await r.json();
    assert.equal(slug, 'root-cause-a-failed-sn', 'slug from the EXPLICIT title');
    const md = await readFile(join(agentRoot, '.agent', 'workflows', `${slug}.md`), 'utf8');
    assert.match(md, /^purpose: Trace a failed serial number/m);
    assert.match(md, /^inputs: \["SN","run"\]$/m);
    assert.match(md, new RegExp(`^promoted_from: ${id}$`, 'm'), 'artifact linkage kept');
    const list = await (await get(srv, port, cookie, '/api/agent/library/workflows')).json();
    const wf = list.workflows.find((w) => w.slug === slug);
    assert.match(wf.purpose, /^Trace a failed serial number/);
  } finally { await srv.close(); }
});

test('workflow list: agent-internal recipe files (no name/title frontmatter) are NOT listed', async () => {
  // data-analyst regression: hand-authored .agent/workflows/*.md with only a
  // `description:` frontmatter key rendered as blank-titled cards. Only
  // dashboard-managed workflows (name: + title: keys) belong in the tab.
  const { meshRoot, agentRoot } = await buildMesh();
  const wfRoot = join(agentRoot, '.agent', 'workflows');
  await mkdir(wfRoot, { recursive: true });
  await writeFile(join(wfRoot, 'fpy-diagnostic-flow.md'),
    '---\ndescription: Perform evidence-based FPY diagnostics.\n---\n\n# FPY Workflow\n', 'utf8');
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const { slug } = await (await post(srv, port, cookie, '/api/agent/library/workflows',
      { title: 'Managed one', purpose: 'p', frame: ['x'] })).json();
    const { workflows } = await (await get(srv, port, cookie, '/api/agent/library/workflows')).json();
    assert.deepEqual(workflows.map((w) => w.slug), [slug], 'recipe file skipped, managed one listed');
  } finally { await srv.close(); }
});

test('artifact list rows include inputs and frame (promote-form prefill)', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    await post(srv, port, cookie, '/api/agent/library/artifacts', textBody());
    const { artifacts } = await (await get(srv, port, cookie, '/api/agent/library/artifacts')).json();
    assert.deepEqual(artifacts[0].inputs, ['SN']);
    assert.deepEqual(artifacts[0].frame, ['ENABLE lookup', 'screenlog triage', 'source trace', 'verdict']);
  } finally { await srv.close(); }
});

test('workflow list: parses frontmatter + frame, sorts created desc then slug; junk skipped', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const wfRoot = join(agentRoot, '.agent', 'workflows');
  await mkdir(wfRoot, { recursive: true });
  const wf = (name, title, inputs, promotedFrom, created, steps) =>
    `---\nname: ${name}\ntitle: ${title}\ninputs: ${JSON.stringify(inputs)}\npromoted_from: ${promotedFrom}\ncreated: ${created}\n---\n# Decision frame\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
  await writeFile(join(wfRoot, 'older.md'), wf('older', 'Older flow', [], '', '2026-06-10', ['only step']), 'utf8');
  await writeFile(join(wfRoot, 'beta.md'), wf('beta', 'Beta flow', ['SN'], '2026-06-11-0800-x', '2026-06-11', ['lookup', 'verdict']), 'utf8');
  await writeFile(join(wfRoot, 'alpha.md'), wf('alpha', 'Alpha flow', ['SN', 'run'], '', '2026-06-11', ['triage']), 'utf8');
  await writeFile(join(wfRoot, 'junk.md'), 'no frontmatter here\n', 'utf8');
  await writeFile(join(wfRoot, 'notes.txt'), 'not a workflow', 'utf8');

  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/workflows');
    assert.equal(r.status, 200);
    const { workflows } = await r.json();
    assert.deepEqual(workflows.map((w) => w.slug), ['alpha', 'beta', 'older'], 'created desc, then slug asc');
    const beta = workflows[1];
    assert.equal(beta.title, 'Beta flow');
    assert.deepEqual(beta.inputs, ['SN']);
    assert.deepEqual(beta.frame, ['lookup', 'verdict'], 'numbered prefixes stripped');
    assert.equal(beta.promoted_from, '2026-06-11-0800-x');
    assert.equal(beta.created, '2026-06-11');
    assert.equal(workflows[0].promoted_from, '', 'direct creation → empty promoted_from');
  } finally { await srv.close(); }
});

test('workflow list: unknown agent → 404; no dir → 200 empty. delete: 200 file gone; bad slug → 400; missing → 404', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/agent/no-such-agent/workflows')).status, 404);
    const empty = await get(srv, port, cookie, '/api/agent/library/workflows');
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).workflows, []);

    const { slug } = await (await post(srv, port, cookie, '/api/agent/library/workflows', { title: 'Throwaway', frame: ['x'] })).json();
    const file = join(agentRoot, '.agent', 'workflows', `${slug}.md`);
    assert.equal(await exists(file), true);

    const r = await del(srv, port, cookie, `/api/agent/library/workflow/${slug}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(await exists(file), false, 'workflow .md removed');

    assert.equal((await del(srv, port, cookie, `/api/agent/library/workflow/${slug}`)).status, 404);
    assert.equal((await del(srv, port, cookie, '/api/agent/library/workflow/bad%24slug')).status, 400);
    assert.equal((await del(srv, port, cookie, '/api/agent/library/workflow/a%2e%2eb')).status, 400);
  } finally { await srv.close(); }
});
