// Scenario 6 — new_conversation durably resets: post-reset B cannot know K
// (fresh transcript) and runs under a DIFFERENT session id (spec §4 #6).
// Turn tasks are DIRECTIVE by design ('Ask your library peer…') — this scenario
// measures the reset wire mechanics, not A's delegation choice.
// Known confound on the answer probe: A's OWN context still carries K from turn 1,
// so a chatty A may echo K even when B's reset thread correctly forgot it —
// a false NEGATIVE only (never a false pass). The session-id probe is the hard gate.
//
// Phrasing note (first live run, 0/3 → fixed): never name a tool or option by its
// INTERNAL id in a task — "call delegate_to_peer with new_conversation…" made the
// worker scan for a tool literally named that (the exposed name is
// mcp__agentmesh_peerbridge__delegate_to_peer), deny having any delegation
// capability, and never delegate. Ask FUNCTIONALLY ("start a completely fresh
// conversation… do not continue the earlier one") — the model then finds the tool
// and sets new_conversation itself from the tool description. Verified live.
import { sessionArg } from '../probes.mjs';

export default {
  name: '06-reset-semantics',
  async setup(h) {
    const K = h.plant('CODEWORD');
    const mesh = await h.buildMesh({
      agents: {
        A: { agentMd: 'General assistant agent.', peers: ['B'] },
        B: { agentMd: 'Library memory agent. Remembers notes told to it within a conversation.' }
      },
      claude: h.claudeBin
    });
    return {
      mesh, driven: 'A', planted: { K },
      turns: [
        { task: `Ask your library peer to remember this codeword: ${K}. Relay its acknowledgment.` },
        { task: 'This time start a completely fresh conversation with your library peer — do not continue your earlier one — and ask it: what codeword were you told? Report its answer verbatim.' }
      ],
      probes: [
        h.probe.answerNotContains(1, K),
        { name: 'reset-uses-fresh-session-id', async check(ctx) {
            const runs = ctx.runs.B || [];
            if (runs.length < 2) return { pass: false, detail: `expected ≥2 B runs, got ${runs.length}` };
            const s1 = sessionArg(runs[0]); const s2 = sessionArg(runs[runs.length - 1]);
            const pass = s2?.flag === '--session-id' && s1?.id && s2.id !== s1.id;
            return { pass, detail: `first=${JSON.stringify(s1)} last=${JSON.stringify(s2)}` };
        } },
        h.probe.peersClean(['A', 'B'])
      ]
    };
  }
};
