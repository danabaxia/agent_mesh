/**
 * test/routing.test.js — Inc C: pure routing core.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { routeByRules, extractQuery, buildRoutingPrompt, validateLlmDecision } from '../src/routing.js';

const PEERS = [
  { name: 'library', modes: ['ask'], primaryTool: { tool: 'search_books', intents: ['find book', 'find the book', 'look up'], argsSchema: { query: 'string' } } },
  { name: 'coding', modes: ['ask', 'do'] } // no primaryTool
];

test('rule pass routes a matching task to the peer fast-path with extracted query', () => {
  const r = routeByRules('find the book Dune for me', PEERS);
  assert.equal(r.route, 'tool');
  assert.equal(r.target, 'library');
  assert.equal(r.toolCall.tool, 'search_books');
  assert.equal(r.toolCall.args.query, 'Dune');
  assert.equal(r.source, 'rule');
});

test('longest intent wins for cleaner extraction', () => {
  const r = routeByRules('find book Dune Messiah', PEERS);
  assert.equal(r.toolCall.args.query, 'Dune Messiah');
});

test('no intent match → llm-needed', () => {
  const r = routeByRules('summarize the latest sprint and write a plan', PEERS);
  assert.equal(r.route, 'llm-needed');
});

test('intent match but empty query → llm-needed (let the model decide)', () => {
  const r = routeByRules('look up', PEERS);
  assert.equal(r.route, 'llm-needed');
});

test('extractQuery strips intent + filler', () => {
  assert.equal(extractQuery('find the book Dune for me', 'find the book'), 'Dune');
  assert.equal(extractQuery('look up Neuromancer please', 'look up'), 'Neuromancer');
});

test('buildRoutingPrompt lists peers + their primaryTool and asks for one JSON object', () => {
  const p = buildRoutingPrompt('find Dune', PEERS);
  assert.match(p, /library/);
  assert.match(p, /search_books/);
  assert.match(p, /"route": "tool"/);
  assert.match(p, /"route": "agent"/);
});

test('validateLlmDecision accepts a declared tool route, rejects undeclared tools', () => {
  const ok = validateLlmDecision({ route: 'tool', target: 'library', toolCall: { tool: 'search_books', args: { query: 'Dune' } } }, PEERS);
  assert.equal(ok.route, 'tool');
  assert.equal(ok.source, 'llm');

  const bad = validateLlmDecision({ route: 'tool', target: 'library', toolCall: { tool: 'rm_rf', args: {} } }, PEERS);
  assert.equal(bad.route, 'none', 'undeclared tool must be rejected');

  const ghost = validateLlmDecision({ route: 'tool', target: 'nope', toolCall: { tool: 'x' } }, PEERS);
  assert.equal(ghost.route, 'none');
});

test('validateLlmDecision accepts an agent route with a task', () => {
  const ok = validateLlmDecision({ route: 'agent', target: 'coding', task: 'review the diff' }, PEERS);
  assert.equal(ok.route, 'agent');
  assert.equal(ok.target, 'coding');
  const noTask = validateLlmDecision({ route: 'agent', target: 'coding' }, PEERS);
  assert.equal(noTask.route, 'none');
});
