import { readBrainKind } from '../runner.js';
import { runGeminiAgent } from '../brains/gemini-agent.js';
import { delegateTask } from '../delegate.js';

/**
 * Shared brain seam: pick the agent's brain from its own card and run one turn.
 * Both serve-a2a (stdio) and serve-a2a-http call this instead of delegateTask
 * directly, so the brain is a swappable step and the two transports stay in parity.
 */
export async function runAgent(args) {
  const kind = await readBrainKind(args.root);
  if (kind === 'gemini') return runGeminiAgent(args);
  return delegateTask(args);
}
