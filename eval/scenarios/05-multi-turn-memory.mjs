// Scenario 5 — multi-turn memory: K exists ONLY in B's live transcript; the
// only recall channel is B's resumed `from:A` session (spec §4 #5). The argv
// probe is the hard gate (answer alone could be confounded by log-grepping).
import { sessionArg } from '../probes.mjs';

export default {
  name: '05-multi-turn-memory',
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
        { task: `Ask your library peer to remember this codeword for later in your conversation with it: ${K}. Relay its acknowledgment.` },
        { task: 'Ask your library peer what codeword it was told earlier in your conversation with it. Report exactly what it says.' }
      ],
      probes: [
        h.probe.answerContains(1, K),
        { name: 'turn2-resumes-turn1-session', async check(ctx) {
            // Ordering-robust against model retries / resume self-heal: find the
            // FIRST fresh-session run, then require ANY later run to resume it.
            const args = (ctx.runs.B || []).map(sessionArg);
            const firstIdx = args.findIndex((s) => s?.flag === '--session-id');
            if (firstIdx === -1) return { pass: false, detail: `no --session-id B run (${args.length} runs)` };
            const first = args[firstIdx];
            const resumed = args.slice(firstIdx + 1).some((s) => s?.flag === '--resume' && s.id === first.id);
            return { pass: resumed, detail: resumed ? `resumed ${first.id}` : `no --resume of ${first.id}; runs=${JSON.stringify(args)}` };
        } },
        h.probe.peersClean(['A', 'B'])
      ]
    };
  }
};
