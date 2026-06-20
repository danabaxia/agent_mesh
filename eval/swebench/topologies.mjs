// eval/swebench/topologies.mjs — topology factory for SWE-bench eval.
// Phase 1: single_worker (control) and ask_chain (treatment).
// Phase 2: architect_editor (gated on issue #97 — do-mode peer delegation).

/**
 * Build the mesh agent spec for a given topology.
 *
 * Topologies:
 *   single_worker — one agent receives the task in ask mode (control arm)
 *   ask_chain     — coordinator agent + specialist peer; coordinator asks peer
 *   architect_editor — architect (ask) + editor (do); gated on #97 (Phase 2)
 *
 * Returns an agents spec compatible with buildMesh() from eval/harness.mjs:
 *   { agents: { NAME: { agentMd?, peers? } }, driven: NAME }
 */
export function buildTopology(name, { agentMd = '' } = {}) {
  switch (name) {
    case 'single_worker':
      return {
        agents: {
          worker: { agentMd: agentMd || 'A software engineering agent that analyzes GitHub issues and explains how to fix them.' }
        },
        driven: 'worker'
      };

    case 'ask_chain':
      return {
        agents: {
          coordinator: {
            agentMd: 'A coordinator agent. For software engineering issues, ask the specialist peer for analysis before answering.',
            peers: ['specialist']
          },
          specialist: {
            agentMd: agentMd || 'A specialist software engineering agent that analyzes GitHub issues in depth.'
          }
        },
        driven: 'coordinator'
      };

    case 'architect_editor':
      throw new Error(
        'architect_editor topology is Phase 2 — requires issue #97 (do-mode peer delegation) to land first.'
      );

    default:
      throw new Error(`unknown topology: "${name}". Valid topologies: single_worker, ask_chain, architect_editor`);
  }
}

/** All topology names currently available (Phase 1 only). */
export const PHASE1_TOPOLOGIES = ['single_worker', 'ask_chain'];

/** All topology names (including Phase 2). */
export const ALL_TOPOLOGIES = ['single_worker', 'ask_chain', 'architect_editor'];
