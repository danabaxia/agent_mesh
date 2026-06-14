#!/usr/bin/env node
// Read-only MCP stdio server: exposes recall_decision over past decisions.
// Newline-delimited JSON-RPC (one JSON object per line).
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// NOTE: this bullet parser intentionally mirrors src/agent-context.js's
// buildDecisionsIndex. The duplication is deliberate — example tool servers are
// standalone (no imports from src/) so the agent folder stays copy-anywhere
// runnable. Keep the two parsers behaviourally in sync if either changes.
export function parseDecisions(text) {
  const lines = text.split('\n');
  const bullets = [];
  let currentBullet = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (currentBullet) {
        bullets.push(currentBullet);
      }
      currentBullet = trimmed;
    } else if (trimmed === '' || trimmed.startsWith('#')) {
      // skip
    } else if (currentBullet) {
      currentBullet += ' ' + trimmed;
    }
  }
  if (currentBullet) {
    bullets.push(currentBullet);
  }
  return bullets;
}

export function searchDecisions(bullets, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return bullets;
  return bullets.filter((b) => b.toLowerCase().includes(q));
}

async function loadDecisions() {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', '..', 'memory', 'decisions.md');
  try {
    const text = await readFile(path, 'utf8');
    return parseDecisions(text);
  } catch {
    return [];
  }
}

function handle(message, decisions) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const { id, method, params } = message;
  if (id === undefined) return null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-recall', version: '0.1.0' }
      }
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'recall_decision',
            description: 'Recall system decisions and rules from memory matching a keyword or date. If query is empty, returns all decisions.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: { type: 'string', description: 'A keyword or date to search for in decisions' }
              }
            }
          }
        ]
      }
    };
  }
  if (method === 'tools/call') {
    if (params?.name !== 'recall_decision') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
    }
    const hits = searchDecisions(decisions, params?.arguments?.query);
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: hits.join('\n') }] }
    };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

async function main() {
  const decisions = await loadDecisions();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          nl = buffer.indexOf('\n');
          continue;
        }
        const response = handle(msg, decisions);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      nl = buffer.indexOf('\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
