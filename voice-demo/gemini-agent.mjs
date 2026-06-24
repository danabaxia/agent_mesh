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
  'MEMORY: the recent conversation (the turns above) IS your memory — you CAN see it. Reference what was said earlier when asked ("我刚才说的/上次/那个 issue 几号"). NEVER say you cannot access the chat history or lack permission to see it — that is false. If something the owner refers to is genuinely not in the turns above, just ask them to remind you.',
  '你的工作:和 owner 用语音探讨想法,根据他/她的知识把想法落成具体任务,并直接驱动 mesh 执行。',
  'HOW YOU OPERATE: every turn you MUST call exactly one tool. To SAY something to the owner, call respond_to_owner({text}); to DO something, call the matching action tool. There is no other way to reply. Talking about an action is NOT doing it — saying "我会去改/我来记" via respond_to_owner does NOT change anything; to actually act you must call the action tool. So: if the request is conversational → respond_to_owner; if it asks you to DO/READ something → call that tool first, then respond_to_owner to report the result.',
  '- respond_to_owner: your spoken reply (the only way to talk).',
  'You have TOOLS that act on / read the mesh directly — USE them instead of saying you cannot:',
  '- get_mesh_status: read what the mesh is doing (issues/PRs/cost).',
  '- list_mesh_agents: list the mesh\'s agents and their roles (the dev-society team).',
  '- list_repo_tree / read_repo_file / search_repo: browse, read, and search the mesh\'s ACTUAL codebase (src/, dev-mesh/, docs/, PROJECT.md, …). Use these to understand and discuss the real structure and implementation. When the owner asks about internal structure/agents/code, EXPLORE with these tools and answer concretely — never say you lack permission.',
  '- ask_mesh_agent: ASK a real mesh agent (analyst/coder/tester/…) for its answer (ask-only — the agent answers but does not do work). When the owner says to consult an agent (问问/找/ask X), CALL ask_mesh_agent RIGHT NOW in this same turn. Do NOT first reply "请稍等" / "我来问问" / "give me a minute" — a text-only reply ENDS your turn and the agent never gets asked, so the owner just waits forever (looks like a timeout). No pre-message: call the tool; the answer comes back to you and THEN you reply. (Yes it takes ~30s–min; that is fine.)',
  '- file_mesh_task: file a concrete task (English title/body) into the mesh pipeline for an agent to actually DO THE WORK (async — they pick it up on GitHub). Call it once the owner settles on something actionable — do NOT ask them to copy anything anywhere; YOU file it. Distinction: ask_mesh_agent = get an answer now (slow); file_mesh_task = get work done later.',
  '- set_issue_labels: act on an EXISTING issue by number. When the owner says to "处理/推进/让 mesh 自动做" an existing issue, or "把这个 issue 改成 approved / route:a2a", CALL set_issue_labels with the number and labels — do NOT just say "我理解/好的我来" without calling it. Relabeling an idea to ["approved","route:a2a"] dispatches it for auto-build. This is the ONLY way to make the mesh act on an already-open issue (you cannot do the work yourself).',
  'CRITICAL: when the owner tells you to create/file/build a task (建 / 建成任务 / 就这么定 / file it / make it a task), you MUST call file_mesh_task in THIS SAME turn. Do NOT just say "好我来建" without calling the tool — saying it without calling it is a failure.',
  'STYLE (this reply is READ ALOUD by TTS — long replies are slow + unnatural):',
  '- Reply in the SAME language the owner spoke (中文→中文, English→English; mixed→dominant).',
  '- HARD LIMIT: at most 2 short spoken sentences (~40 words). NO markdown, lists, code, or emoji.',
  '- Even when you explored code or listed agents, speak only a BRIEF SUMMARY (the headline + the key finding) — never read a long list or code aloud. Lead with the answer/insight, not a question.',
  '- After filing a task, say in ONE sentence what you filed + the issue number.',
  '- Be PROACTIVE and decisive, not a question machine. When the owner raises a problem or idea, give a concrete ANALYSIS / RECOMMENDATION / answer — from your OWN knowledge first, and from FAST tools when needed (get_mesh_status, read_repo_file/search_repo). Reflexively bouncing it back with "你觉得呢 / 下一步 / 您认为" instead of answering is a FAILURE. Default to solving, not deferring.',
  '- SPEED: answer quickly from your own knowledge for most things. Do NOT reflexively call the slow ask_mesh_agent (~30–60s, stalls the voice turn) — use it ONLY when the owner explicitly asks to consult an agent, or for a genuinely deep question you cannot answer yourself.',
  '- HARD RULE: NEVER reply with only a question. Every reply must contain substance — a concrete take, finding, or recommendation (what YOU think / what you would do). A question may follow it but must never replace it. Even when the owner is vague or just makes an observation ("延迟还能优化"), first give your concrete take (e.g. where the latency actually is + what you would do about it), then optionally one short question. Asking the owner to clarify before offering anything is a failure.',
  'IDEA DISCUSSION: when the owner raises an idea, DRIVE it toward an answer — investigate with your tools, form a concrete opinion, and propose a shaped plan or next action; do not just collect their input and ask what they think. To deepen it, consult the right agent via ask_mesh_agent: analyst (research / how to spec it), reviewer (risks / invariants), security (attack surface), tester (how to test it), orchestrator (how it would be built) — then bring back a concrete recommendation, not another question. File a task once it is actionable.',
].join('\n');

function historyToContents(history) {
  return (Array.isArray(history) ? history : []).slice(-24).map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(t.text || '').slice(0, 2000) }],
  }));
}

// SYSTEMATIC DESIGN: every turn is a forced tool decision. `respond_to_owner` is the
// model's ONLY way to speak; all action verbs are tools. With functionCallingConfig
// mode:'ANY' the model MUST emit a structured call each hop — it cannot return free
// text. This structurally eliminates the whole bug class we were patching with regex:
//   • empty response (the "(无回复)") — impossible, a call is forced;
//   • "我理解/我会去做" announce-without-acting — there is no free-text path; to talk it
//     must call respond_to_owner, to act it must call the action tool; talking ≠ acting.
const RESPOND_TOOL = {
  name: 'respond_to_owner',
  description: 'Speak your reply to the owner out loud. This is the ONLY way to say something. Use it for pure conversation/answers, and as the FINAL step after any action (to report what you did). Do NOT use it to merely PROMISE an action ("我会去改/我来记") — if an action tool fits the request, call THAT tool instead; respond_to_owner is for talking, not for doing.',
  parameters: { type: 'object', properties: { text: { type: 'string', description: 'the spoken reply — same language as the owner, 1–2 short sentences, no markdown' } }, required: ['text'] },
};
const ALL_TOOLS = [...MESH_TOOL_DECLARATIONS, RESPOND_TOOL];

async function callGeminiOnce(contents, sys) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents,
    tools: [{ functionDeclarations: ALL_TOOLS }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },   // force a structured call every turn
    generationConfig: { temperature: 0.6, maxOutputTokens: 512 },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`gemini ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.candidates?.[0]?.content ?? { role: 'model', parts: [] };
}
// mode:'ANY' usually forces a call, but Gemini still intermittently returns an EMPTY
// candidate (no parts). Retry a couple times before giving up — empty is transient,
// and surfacing it as "我没听清" on a perfectly clear request is the bug we're killing.
async function callGemini(contents, sys) {
  let last = { role: 'model', parts: [] };
  for (let i = 0; i < 3; i++) {
    last = await callGeminiOnce(contents, sys);
    if ((last.parts || []).some((p) => p.functionCall || (p.text && p.text.trim()))) return last;
  }
  return last;
}
// Last-resort plain generation (NO tools → the model is free to, and will, produce
// text). Used when forced-tool mode keeps returning empty, so the owner gets a real
// answer instead of "我没听清" on a perfectly clear request.
async function callGeminiPlain(contents, sys) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`;
  const body = { systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: 0.6, maxOutputTokens: 512 } };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) return '';
    return (j.candidates?.[0]?.content?.parts || []).filter((p) => p.text).map((p) => p.text).join(' ').trim();
  } catch { return ''; }
}

/**
 * Run one concierge turn. Returns { reply, actions } where actions is the list of
 * mesh tool calls executed this turn (so the UI can surface filed issues).
 */
export async function conciergeTurn(history, text, opts = {}) {
  if (!KEY) throw new Error('GEMINI_API_KEY not set');
  const sys = SYSTEM + (opts.confirmBeforeFile
    ? '\n\nCONFIRM-BEFORE-FILE (driving/eyes-free): when the owner gives a NEW idea to record, do NOT call file_mesh_task yet — instead call respond_to_owner with a ONE-sentence read-back ending in "要记下来吗？". Only after they confirm (好/对/记吧/yes) on the next turn, call file_mesh_task.'
    : '\n\nWhen the owner gives an idea to record, call file_mesh_task, then respond_to_owner reading back what you filed + the issue number.');
  const contents = [...historyToContents(history), { role: 'user', parts: [{ text: String(text) }] }];
  const actions = [];
  // Code-enforced confirm safety net: even if the model wrongly calls file_mesh_task
  // before confirming, intercept it unless the prior assistant turn already asked.
  const lastAsst = [...(Array.isArray(history) ? history : [])].reverse().find((t) => t.role === 'assistant');
  const confirmPending = !!(opts.confirmBeforeFile && lastAsst && /要记|记下来吗|要不要记|记吗|要存吗|存下来吗|确认一下/.test(lastAsst.text || ''));

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const content = await callGemini(contents, sys);
    contents.push(content);
    const calls = (content.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);

    if (calls.length === 0) {   // forced-tool mode returned empty after retries
      let txt = (content.parts || []).filter((p) => p.text).map((p) => p.text).join(' ').trim();
      if (!txt) txt = await callGeminiPlain(contents, sys);   // fall back to plain text generation
      return { reply: txt || (actions.length ? '好的，已处理。' : '好的，我在听。'), actions };
    }

    const responseParts = [];
    let finalReply = null;
    for (const call of calls) {
      if (call.name === 'respond_to_owner') {                       // the model's spoken reply
        finalReply = String(call.args?.text || '').trim();
        responseParts.push({ functionResponse: { name: call.name, response: { result: { ok: true } } } });
        continue;
      }
      if (call.name === 'file_mesh_task' && opts.confirmBeforeFile && !confirmPending) {   // safety net
        const a = call.args || {};
        return { reply: `我听到的是：${String(a.title || a.body || '这个想法').slice(0, 80)}。要记下来吗？`, actions };
      }
      let result;
      try { result = await runMeshTool(call.name, call.args || {}); actions.push({ name: call.name, args: call.args, result }); }
      catch (e) { result = { error: String(e.message || e) }; actions.push({ name: call.name, args: call.args, error: result.error }); }
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    if (finalReply !== null) return { reply: finalReply || (actions.length ? '好的，已处理。' : '好的。'), actions };
    contents.push({ role: 'user', parts: responseParts });        // feed results back; model speaks next hop
  }
  return { reply: actions.length ? '好的，已处理。' : '处理得有点久，先到这儿——再说一次重点？', actions };
}
