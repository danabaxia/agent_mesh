// Scenario 4 — roster A/B: turn-0 peer roster present vs suppressed
// (AGENT_MESH_EVAL_NO_ROSTER), measured on the DISTRACTOR fixture from
// scenario 3 (three peers, fact owned by one). A single-peer mesh showed
// 100%/100% on both arms — too easy to differentiate; with distractors the
// roster's value shows up as right-peer rate and wrong-peer cost. Reported
// as a compare entry, excluded from the pass/fail aggregate (spec §4 #4).
export default {
  name: '04-roster-ab',
  async run(h, { trials, claude, timeoutMs, log = () => {} }) {
    const armEnvs = { roster: {}, noRoster: { AGENT_MESH_EVAL_NO_ROSTER: '1' } };
    const zero = () => ({ delegated: 0, rightPeer: 0, wrongPeer: 0, answered: 0, errors: 0 });
    const tally = { roster: zero(), noRoster: zero() };
    // Interleave arms per trial index so any temporal drift in the live model
    // hits both arms equally (canonical A/B hygiene), not all-roster-then-all-not.
    for (let t = 0; t < trials; t++) {
      for (const arm of ['roster', 'noRoster']) {
        const fact = h.plant('INV');
        let mesh = null;
        try {
          mesh = await h.buildMesh({
            agents: {
              A: { agentMd: 'General assistant agent.', peers: ['library', 'billing', 'weather'] },
              library: { agentMd: 'Library catalog agent. Capabilities: catalog lookup, shelf locations.' },
              billing: {
                agentMd: 'Billing agent. Capabilities: invoices, payment records. ' +
                         'Owns the canonical invoice and payment records.',
                files: { 'data/invoices.md': `Invoice 2026-051 reference: ${fact}\n` }
              },
              weather: { agentMd: 'Weather agent. Capabilities: forecasts.' }
            },
            claude
          });
          const results = await h.driveAgent(mesh, 'A',
            [{ task: 'What is the payment reference for invoice 2026-051? Reply with the exact reference.' }],
            { claude, timeoutMs, callerTag: `eval-04-${arm}-${t}`, agentEnv: armEnvs[arm] });
          const anchor = results[0]?.runId;
          const ranWithEdge = async (name) =>
            (await h.readRuns(mesh.agents[name])).some((r) => anchor && r.parent_run_id === anchor);
          const right = await ranWithEdge('billing');
          const wrong = (await ranWithEdge('library')) || (await ranWithEdge('weather'));
          if (right || wrong) tally[arm].delegated++;
          if (right) tally[arm].rightPeer++;
          if (wrong) tally[arm].wrongPeer++;
          if ((results[0]?.answer || '').includes(fact)) tally[arm].answered++;
        } catch (e) {
          tally[arm].errors++;
          log(`  04-roster-ab ${arm} trial ${t} ERROR: ${e.message}`);
        } finally {
          if (mesh) await h.cleanupMesh(mesh).catch(() => {});
        }
        log(`  04-roster-ab ${arm} trial ${t} done`);
      }
    }
    const compare = {};
    for (const arm of ['roster', 'noRoster']) {
      const c = tally[arm];
      compare[arm] = {
        trials,
        delegationRate: c.delegated / trials,
        rightPeerRate: c.rightPeer / trials,
        wrongPeerRate: c.wrongPeer / trials,
        answerRate: c.answered / trials,
        errorRate: c.errors / trials
      };
    }
    return { name: '04-roster-ab', compare };
  }
};
