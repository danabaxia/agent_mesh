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
  '- ask_mesh_agent: ASK a real mesh agent (analyst/coder/tester/…) for its answer (ask-only — the agent answers but does not do work). When the owner says to consult an agent (问问/找/ask X), CALL ask_mesh_agent RIGHT NOW in this same turn. Do NOT first reply "请稍等" / "我来问问" / "give me a minute" — a text-only reply ENDS your turn and the agent never gets asked, so the owner just waits forever (looks like a timeout). No pre-message: call the tool; the answer comes back to you and THEN you reply. (Yes it takes ~30s–min; that is fine.)',
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

async function callGemini(contents, mode = 'AUTO', sys = SYSTEM) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
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
// "Announce but don't call": the model says it WILL ask/file but emits no function
// call → the action never happens and the owner waits forever. Force a real call.
const ANNOUNCE_RE = /(我来|我帮你|我去|让我|稍等|请稍等|马上|这就|i'?ll|let me|going to|i will)[\s\S]{0,8}?(问|记|建|开|录|查|file|create|log|ask|note|save|record|check)/i;

/**
 * Run one concierge turn. Returns { reply, actions } where actions is the list of
 * mesh tool calls executed this turn (so the UI can surface filed issues).
 */
export async function conciergeTurn(history, text, opts = {}) {
  if (!KEY) throw new Error('GEMINI_API_KEY not set');
  // Eyes-free safety: when the owner is driving they can't read the screen, so a
  // misheard idea could silently create a junk task. confirmBeforeFile makes the
  // 门房 read the idea back and wait for a "好/对" before calling file_mesh_task.
  const sys = SYSTEM + (opts.confirmBeforeFile
    ? '\n\nCONFIRM-BEFORE-FILE (driving/eyes-free): before calling file_mesh_task, do NOT file yet — first reply with a ONE-sentence read-back of the task and ask "要记下来吗？". Only on the NEXT turn, if the owner confirms (好/对/记吧/yes), call file_mesh_task RIGHT THEN (do not just say "好的我来记" — actually call it). If they say 取消/不用/no, drop it. (get_mesh_status / ask_mesh_agent / reads need no confirmation.)'
    : '\n\nWhen the owner gives an idea to record, call file_mesh_task NOW in this same turn (do NOT ask "对吗？", do NOT say "我来记" without calling — just call it). Then your reply reads back what you filed + the issue number so a mishearing is caught by ear.');
  const contents = [...historyToContents(history), { role: 'user', parts: [{ text: String(text) }] }];
  const actions = [];

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    let content = await callGemini(contents, 'AUTO', sys);
    let parts = content.parts || [];
    let calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    // Recover from a leaked tool call (Gemini emitted the call as text). Re-ask with
    // mode:'ANY' to force a structured functionCall instead of the text leak.
    if (calls.length === 0) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join(' ');
      // Recover from: (a) an EMPTY response (no text, no call — Gemini intermittently
      // returns this → the owner saw "(无回复)"), or (b) a leaked/announced-but-not-
      // called intent. Force a structured call (mode:ANY) so it actually acts.
      if (!text.trim() || LEAK_RE.test(text) || ANNOUNCE_RE.test(text)) {
        const forced = await callGemini([...contents, content, { role: 'user', parts: [{ text: '（系统：请立即用结构化函数调用执行该请求，或直接给出文字回答，不要返回空。）' }] }], 'ANY', sys);
        const fParts = forced.parts || [];
        const fCalls = fParts.filter((p) => p.functionCall).map((p) => p.functionCall);
        if (fCalls.length) { content = forced; parts = fParts; calls = fCalls; }
      }
    }
    contents.push(content);

    if (calls.length === 0) {
      const reply = parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
      return { reply: reply || (actions.length ? '好的，已处理。' : '我没太理解，可以再说一次吗？'), actions };
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
