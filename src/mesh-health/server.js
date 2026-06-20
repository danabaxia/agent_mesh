/**
 * src/mesh-health/server.js — stdio MCP wrapper around the mesh-health core.
 *
 * Read-only by design: three verbs (check_conformance / ping_agent /
 * triage_logs), every result a JSON text payload via mcpTextResult. Registered
 * in <mesh-root>/mesh/mcp.json with the x-agentmesh readOnly marker so
 * ask-mode delegations receive it. NOT named agentmesh_* (that prefix is
 * reserved for framework-injected servers and dropped from registry sources).
 */
import { StdioTransport, rpcError } from '../mcp.js';
import { mcpTextResult } from '../contract.js';
import { createMeshHealth } from './core.js';

export const SERVER_NAME = 'mesh-health';

export function createMeshHealthServer({ meshRoot, env = process.env }) {
  const health = createMeshHealth({ meshRoot, env });

  return {
    async start(input, output) {
      const transport = new StdioTransport(input, output, async (message) => {
        const response = await handle(message, health);
        if (response) transport.send(response);
      });
      transport.start();
      await new Promise((resolveP) => input.on('end', resolveP));
    }
  };
}

async function handle(message, health) {
  if (!message || typeof message !== 'object') return null;
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.1.0' }
      }
    };
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: buildTools() } };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'check_conformance') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.checkConformance()) };
    }
    if (name === 'ping_agent') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.pingAgent(args)) };
    }
    if (name === 'triage_logs') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.triageLogs(args)) };
    }
    if (name === 'list_stale_tasks') {
      return { jsonrpc: '2.0', id, result: mcpTextResult(await health.listStaleTasks(args)) };
    }
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  }

  if (id === undefined) return null;
  return rpcError(id, -32601, `Unknown method: ${method}`);
}

function buildTools() {
  return [
    {
      name: 'list_stale_tasks',
      description:
        'Scan the mesh task board for tasks stuck in a non-terminal state ' +
        '(assigned / acknowledged / in-progress) past a configurable age. ' +
        'Returns { stale_ms, tasks: [{ id, from, to, state, last_at, age_ms }] }. ' +
        'Stale age defaults to AGENT_MESH_BOARD_STALE_MS (86 400 000 ms / 24 h). ' +
        'Never modifies tasks — read-only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stale_ms: {
            type: 'number',
            minimum: 1,
            description: 'age threshold in ms; omit to use the server default (24 h)'
          }
        }
      }
    },
    {
      name: 'check_conformance',
      description:
        'Run the mesh structural conformance check and doctor DRY-RUN over the whole mesh. ' +
        'Returns { ok, counts:{pass,warn,fail}, problems:[{rule,level,detail}], doctor_dry_run } — ' +
        'what `agent-mesh doctor --apply` WOULD fix. Never applies anything.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    },
    {
      name: 'ping_agent',
      description:
        'Liveness-probe one served agent by name: spawns its A2A server and round-trips ' +
        'initialize + ping (no model turn). Returns { name, alive, latency_ms } or ' +
        '{ name, alive:false, error } where error is unknown_agent | not_served | timeout | probe_failed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } }
      }
    },
    {
      name: 'triage_logs',
      description:
        'Scan agents\' run logs (.agent-mesh/logs) and scheduled-job state for recent failures ' +
        '(timeout / error / refused / rejected). Returns per-agent counts, the most recent ' +
        'failures with log file paths as evidence, and scheduled-job last statuses.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent: { type: 'string', minLength: 1, description: 'limit to one agent name' },
          since_hours: { type: 'number', minimum: 1, maximum: 720, description: 'window, default 24' }
        }
      }
    }
  ];
}
