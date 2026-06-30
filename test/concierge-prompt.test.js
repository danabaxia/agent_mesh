import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const md = readFileSync('dev-mesh/concierge/prompts/system.md', 'utf8');

test('concierge prompt has ideation behavior + first-turn spark + one-tool discipline', () => {
  assert.match(md, /brainstorm_seeds/);
  assert.match(md, /first turn/i);                 // open with a spark on the first turn
  assert.match(md, /one (idea|spark)|develop/i);   // develop the owner's thought
  assert.match(md, /propose_idea/);                // capture on a later confirming turn
});
