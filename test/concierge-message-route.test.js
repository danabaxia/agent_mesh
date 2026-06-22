import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConcierge } from '../src/dashboard/concierge.js';

async function root() { return mkdtemp(join(tmpdir(), 'cmsg-')); }

// A2A Task carries the summary in artifacts[].parts[].text (not .summary).
const taskWith = (text) => ({ task: { artifacts: [{ name: 'summary', parts: [{ text }] }] } });

test('message routes to the concierge AGENT via the broker (ask, lean text)', async () => {
  let sent = null;
  const broker = { send: async (a) => { sent = a; return taskWith('Health is green.'); } };
  const c = createConcierge({ meshRoot: await root(), broker, peers: ['tester'] });
  const out = await c.message({ text: 'is the mesh healthy?' });
  assert.equal(sent.agentName, 'concierge');
  assert.equal(sent.mode, 'ask');
  assert.ok(sent.text.includes('is the mesh healthy?'));
  assert.ok(!sent.text.includes('You are the Mesh Concierge'), 'persona is in AGENT.md, not the sent text');
  assert.equal(out.reply, 'Health is green.');
});

test('a broker failure surfaces as a 502 ConciergeError', async () => {
  const broker = { send: async () => { throw new Error('not_served'); } };
  const c = createConcierge({ meshRoot: await root(), broker, peers: [] });
  await assert.rejects(() => c.message({ text: 'hi' }), (e) => e.status === 502);
});

test('confirm delegates to the dispatcher (file_issue)', async () => {
  let gh = null;
  const c = createConcierge({ meshRoot: await root(), broker: { send: async () => ({}) },
    runGh: async (a) => { gh = a; return { url: 'u' }; }, peers: ['tester'] });
  const out = await c.confirm({ action: 'file_issue', payload: { title: 'T', labels: ['idea'] } });
  assert.equal(out.url, 'u');
  assert.deepEqual(gh.labels, ['idea']);
});

test('confirm assign_task routes to the board for an allowlisted peer (from=concierge)', async () => {
  let created = null;
  const c = createConcierge({ meshRoot: await root(), broker: { send: async () => ({}) },
    createTask: async (mr, t) => { created = t; return { id: 'tester-1' }; }, peers: ['tester'] });
  const out = await c.confirm({ action: 'assign_task', payload: { peer: 'tester', title: 'rerun', objective: 'run suite' } });
  assert.equal(created.from, 'concierge');
  assert.equal(created.to, 'tester');
  assert.equal(out.task_id, 'tester-1');
});

test('parseProposal carries action types', async () => {
  const { parseProposal } = await import('../src/dashboard/concierge.js');
  assert.equal(parseProposal('```concierge-proposal\n{"title":"T","labels":["idea"]}\n```').action, 'file_issue');
  const at = parseProposal('```concierge-proposal\n{"action":"assign_task","peer":"tester","title":"T","objective":"o"}\n```');
  assert.equal(at.action, 'assign_task'); assert.equal(at.peer, 'tester');
  const rr = parseProposal('```concierge-proposal\n{"action":"ask_peer_rerun","peer":"tester","task":"rerun"}\n```');
  assert.equal(rr.action, 'ask_peer_rerun'); assert.equal(rr.task, 'rerun');
});
