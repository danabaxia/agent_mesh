#!/usr/bin/env node
// Read-only MCP stdio server: exposes search_books over the agent's own catalog.
// Newline-delimited JSON-RPC (one JSON object per line), matching agent-mesh's
// own MCP transport. Owns NO write capability — it only reads books.json.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export function searchBooks(books, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !Array.isArray(books)) return [];
  return books.filter(
    (b) =>
      b &&
      typeof b === 'object' &&
      (String(b.title || '').toLowerCase().includes(q) ||
        String(b.author || '').toLowerCase().includes(q))
  );
}

async function loadCatalog() {
  // books.json lives at the agent root: tools/book-search/ -> ../../books.json
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..', '..', 'books.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.books || [];
  } catch {
    return [];
  }
}

function handle(message, catalog) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const { id, method, params } = message;
  // JSON-RPC notifications (no id) get no response, for any method.
  if (id === undefined) return null;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'book-search', version: '0.1.0' }
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
            name: 'search_books',
            description: 'Search the library catalog by title or author. Returns matching {title, author, shelf}.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['query'],
              properties: { query: { type: 'string', minLength: 1 } }
            }
          }
        ]
      }
    };
  }
  if (method === 'tools/call') {
    if (params?.name !== 'search_books') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
    }
    const hits = searchBooks(catalog, params?.arguments?.query);
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(hits) }] }
    };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

async function main() {
  const catalog = await loadCatalog();
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
        const response = handle(msg, catalog);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }
      nl = buffer.indexOf('\n');
    }
  });
}

// Only start the server when run directly — importing for tests must not block on stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
