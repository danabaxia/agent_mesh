import { delegateTask } from './delegate.js';
import { describeFolder } from './description.js';
import { mcpTextResult } from './contract.js';
import { SerialQueue } from './lock.js';

export async function createMcpServer({ root, env }) {
  const self = await describeFolder(root);
  const queue = new SerialQueue();

  return {
    async start(input, output) {
      const transport = new StdioTransport(input, output, async (message) => {
        const response = await handleMessage({ message, root, env, self, queue });
        if (response) transport.send(response);
      });
      transport.start();
      await new Promise((resolve) => input.on('end', resolve));
    }
  };
}

async function handleMessage({ message, root, env, self, queue }) {
  if (!message || typeof message !== 'object') return null;
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-mesh', version: '0.1.0' }
      }
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: buildTools(self)
      }
    };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'describe_self') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(self) };
    }
    if (name === 'delegate_task') {
      const result = await queue.run(() => delegateTask({ root, env, input: args }));
      return { jsonrpc: '2.0', id, result: mcpTextResult(result) };
    }
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  }

  if (id === undefined) return null;
  return rpcError(id, -32601, `Unknown method: ${method}`);
}

function buildTools(self) {
  return [
    {
      name: 'describe_self',
      description: 'Return this peer folder purpose and capabilities from bounded AGENT.md metadata.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {}
      }
    },
    {
      name: 'delegate_task',
      description: `Delegate a scoped task to peer folder "${self.name}". Peer description: ${self.description}`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'task'],
        properties: {
          mode: { type: 'string', enum: ['ask', 'do'] },
          task: { type: 'string', minLength: 1, maxLength: 16384 }
        }
      }
    }
  ];
}

export function rpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message }
  };
}

export class StdioTransport {
  constructor(input, output, onMessage) {
    this.input = input;
    this.output = output;
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  start() {
    this.input.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  send(message) {
    // MCP stdio transport is newline-delimited JSON-RPC (one JSON object per
    // line, no embedded newlines). JSON.stringify never emits literal
    // newlines, so a single line + "\n" terminator is the wire format.
    // (Was LSP-style Content-Length framing — a real MCP client could not
    // parse it, so the handshake never completed. Caught by the real-claude
    // E2E, never by the self-framed unit test.)
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  drain() {
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) return;
        const line = this.buffer.subarray(0, newline).toString('utf8').trim();
        this.buffer = this.buffer.subarray(newline + 1);
        if (!line) continue;
        this.dispatchJson(line);
        continue;
      }

      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.subarray(messageStart, messageEnd).toString('utf8');
      this.buffer = this.buffer.subarray(messageEnd);
      this.dispatchJson(body);
    }
  }

  dispatchJson(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    this.onMessage(message).catch((error) => {
      const id = message && typeof message === 'object' ? message.id : null;
      if (id !== undefined && id !== null) {
        this.send(rpcError(id, -32603, error.message));
      }
    });
  }
}
