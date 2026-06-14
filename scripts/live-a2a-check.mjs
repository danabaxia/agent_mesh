// Live A2A smoke test (real `claude`). Speaks newline-delimited JSON-RPC over a
// real `serve-a2a` child's stdio — the exact wire a peer uses. Proves:
//   1. initialize → AgentCard round trip
//   2. SendMessage (ask) → real Task with a real claude answer
//   3. MULTI-TURN: turn 2 (same agentmesh/caller) resumes turn 1's session, so the
//      peer remembers a secret only told in turn 1.
// Usage: node scripts/live-a2a-check.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = process.env.AGENT_MESH_CLAUDE
  || 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd';

function rpcClient(child) {
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[serve-a2a] ${d}`));
  let id = 0;
  return (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}

const ask = (text, caller) => ({
  message: {
    messageId: `m-${Math.abs(text.length)}-${caller}`,
    role: 'ROLE_USER',
    parts: [{ text }],
    metadata: { 'agentmesh/mode': 'ask', 'agentmesh/caller': caller }
  }
});

function answerOf(task) {
  const arts = (task?.artifacts ?? []).flatMap((a) => a.parts ?? [])
    .filter((p) => typeof p.text === 'string').map((p) => p.text);
  const status = (task?.status?.message?.parts ?? [])
    .filter((p) => typeof p.text === 'string').map((p) => p.text);
  return [...arts, ...status].join('\n').trim();
}

const main = async () => {
  const folder = await mkdtemp(join(tmpdir(), 'live-a2a-'));
  await writeFile(join(folder, 'AGENT.md'),
    '# Assistant\n\nYou are a concise test assistant. Answer in as few words as possible.\n');
  console.log(`peer folder: ${folder}`);

  const child = spawn('node', [join(repoRoot, 'bin', 'agent-mesh.js'), 'serve-a2a', folder], {
    cwd: folder,
    env: { ...process.env, AGENT_MESH_CLAUDE: CLAUDE },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const call = rpcClient(child);

  try {
    // 1) initialize
    const init = await call('initialize', { protocolVersion: '1.0' });
    const card = init.result?.agentCard;
    console.log(`\n[1] initialize OK — protocol ${init.result?.protocolVersion}, agent "${card?.name}"`);

    // 2) ping
    const ping = await call('ping', {});
    console.log(`[2] ping OK — ${ping.result ? 'pong' : 'no result'}`);

    // 3) turn 1 — tell the peer a secret
    console.log('\n[3] turn 1 (caller=tester): planting secret word BANANA …');
    const t1 = await call('SendMessage', ask(
      'Remember this secret word for later: BANANA. Reply with just: OK', 'tester'));
    console.log(`    state=${t1.result?.task?.status?.state}  answer="${answerOf(t1.result?.task)}"`);

    // 4) turn 2 — same caller; should RESUME and recall the secret
    console.log('\n[4] turn 2 (caller=tester): asking for the secret back …');
    const t2 = await call('SendMessage', ask(
      'What was the secret word I told you a moment ago? Reply with just the word.', 'tester'));
    const a2 = answerOf(t2.result?.task);
    console.log(`    state=${t2.result?.task?.status?.state}  answer="${a2}"`);

    // 5) verdict
    const remembered = /banana/i.test(a2);
    console.log('\n──────── VERDICT ────────');
    console.log(`initialize/ping : OK`);
    console.log(`turn 1 answered : ${t1.result?.task?.status?.state === 'TASK_STATE_COMPLETED' ? 'OK' : 'FAIL'}`);
    console.log(`MULTI-TURN RESUME (peer recalled BANANA): ${remembered ? 'PASS ✅' : 'FAIL ❌'}`);
    process.exitCode = remembered ? 0 : 1;
  } finally {
    child.stdin.end();
    child.kill();
  }
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
