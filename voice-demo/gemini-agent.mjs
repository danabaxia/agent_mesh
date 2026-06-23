/**
 * The conversation brain: a bilingual mesh concierge that DISCUSSES with the owner
 * and AUTOMATICALLY drives the mesh through function calls — files tasks, reads
 * status — with no manual copy-paste. This is the 串联.
 *
 * Brain: Google Gemini (free-tier key in GEMINI_API_KEY). Provider-swappable — set
 * OPENAI_API_KEY to switch (TODO: openai backend); the tool contract is the same.
 */
import { MESH_TOOL_DECLARATIONS, runMeshTool } from './mesh-tools.mjs';

const MODEL = process.env.VOICE_GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;
const MAX_TOOL_HOPS = 5;

const SYSTEM = [
  'You are the owner\'s bilingual (中文 / English) VOICE concierge for their personal "agent mesh".',
  '你的工作:和 owner 用语音探讨想法,根据他/她的知识把想法落成具体任务,并直接驱动 mesh 执行。',
  'You have TOOLS that act on / read the mesh directly — USE them instead of saying you cannot:',
  '- get_mesh_status: read what the mesh is doing (issues/PRs/cost).',
  '- list_mesh_agents: list the mesh\'s agents and their roles (the dev-society team).',
  '- list_repo_tree / read_repo_file / search_repo: browse, read, and search the mesh\'s ACTUAL codebase (src/, dev-mesh/, docs/, PROJECT.md, …). Use these to understand and discuss the real structure and implementation. When the owner asks about internal structure/agents/code, EXPLORE with these tools and answer concretely — never say you lack permission.',
  '- ask_mesh_agent: ASK a real mesh agent (analyst/coder/tester/…) for its answer (ask-only — the agent answers but does not do work). When the owner says to consult an agent (问问/找/ask X), call ask_mesh_agent directly with that agent and question — actually call it, do not just say you will. It is slow (~30s–min); that is expected, and your spoken reply comes after the agent answers.',
  '- file_mesh_task: file a concrete task (English title/body) into the mesh pipeline for an agent to actually DO THE WORK (async — they pick it up on GitHub). Call it once the owner settles on something actionable — do NOT ask them to copy anything anywhere; YOU file it. Distinction: ask_mesh_agent = get an answer now (slow); file_mesh_task = get work done later.',
  'CRITICAL: when the owner tells you to create/file/build a task (建 / 建成任务 / 就这么定 / file it / make it a task), you MUST call file_mesh_task in THIS SAME turn. Do NOT just say "好我来建" without calling the tool — saying it without calling it is a failure.',
  'STYLE (this reply is READ ALOUD by TTS — long replies are slow + unnatural):',
  '- Reply in the SAME language the owner spoke (中文→中文, English→English; mixed→dominant).',
  '- HARD LIMIT: at most 2 short spoken sentences (~40 words). NO markdown, lists, code, or emoji.',
  '- Even when you explored code or listed agents, speak only a BRIEF SUMMARY (the headline + a count), then ask if they want detail on a specific one — never read a long list or code aloud.',
  '- After filing a task, say in ONE sentence what you filed + the issue number.',
  '- When discussing, reflect the idea, suggest 1 concrete next step, ask ONE question.',
  'IDEA DISCUSSION: brainstorming an idea with the owner is a core job. Develop it together — clarify intent, surface trade-offs, shape it toward something actionable. To deepen it you may consult the right agent via ask_mesh_agent: analyst (research / how to spec it), reviewer (risks / does it break invariants), security (attack surface), tester (how to test it), orchestrator (how it would be built). Bring their input back into the conversation. Only file_mesh_task once the owner is happy with the shaped idea.',
].join('\n');

function historyToContents(history) {
  return (Array.isArray(history) ? history : []).slice(-10).map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(t.text || '').slice(0, 2000) }],
  }));
}

async function callGemini(contents, mode = 'AUTO') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    tools: [{ functionDeclarations: MESH_TOOL_DECLARATIONS }],
    toolConfig: { functionCallingConfig: { mode } },   // ANY = force a structured call
    generationConfig: { temperature: 0.6, maxOutputTokens: 512 },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`gemini ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.candidates?.[0]?.content ?? { role: 'model', parts: [] };
}

// Gemini sometimes leaks a tool call as TEXT (e.g. `tool_code` / `print(default_api.x(...))`)
// instead of a structured functionCall. Detect that so we can force a real call.
const LEAK_RE = /default_api\.|tool_code|print\(|(?:ask_mesh_agent|file_mesh_task|get_mesh_status|list_mesh_agents|read_repo_file|search_repo|list_repo_tree)\s*\(/;

/**
 * Run one concierge turn. Returns { reply, actions } where actions is the list of
 * mesh tool calls executed this turn (so the UI can surface filed issues).
 */
export async function conciergeTurn(history, text) {
  if (!KEY) throw new Error('GEMINI_API_KEY not set');
  const contents = [...historyToContents(history), { role: 'user', parts: [{ text: String(text) }] }];
  const actions = [];

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    let content = await callGemini(contents);
    let parts = content.parts || [];
    let calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    // Recover from a leaked tool call (Gemini emitted the call as text). Re-ask with
    // mode:'ANY' to force a structured functionCall instead of the text leak.
    if (calls.length === 0) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join(' ');
      if (LEAK_RE.test(text)) {
        content = await callGemini(contents, 'ANY');
        parts = content.parts || [];
        calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      }
    }
    contents.push(content);

    if (calls.length === 0) {
      const reply = parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
      return { reply: reply || '(无回复)', actions };
    }

    // Execute every tool call, feed results back as functionResponse parts.
    const responseParts = [];
    for (const call of calls) {
      let result;
      try { result = await runMeshTool(call.name, call.args || {}); actions.push({ name: call.name, args: call.args, result }); }
      catch (e) { result = { error: String(e.message || e) }; actions.push({ name: call.name, args: call.args, error: result.error }); }
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  // Tool-hop budget exhausted — return whatever text we can salvage.
  return { reply: '我处理得有点久,先到这儿——再说一次你的重点?', actions };
}
