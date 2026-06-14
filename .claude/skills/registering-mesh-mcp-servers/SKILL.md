---
name: registering-mesh-mcp-servers
description: Use when adding, registering, or wiring an MCP server (stdio or HTTP) into the agent-mesh so mesh agents can use it — covers which file to edit, mode-gating with the x-agentmesh readOnly marker, and the credential gotcha.
---

# Registering MCP Servers in the Agent Mesh

## Overview

The mesh hands `claude` a single assembled MCP config per delegation (`src/mesh-mcp.js` `assembleMcpServers`). Registering a server = adding one entry to the right `mcpServers` map. **Declaration ≠ grant**: whether an agent actually *gets* the server is decided by **mode** + the `x-agentmesh` marker, not by declaring it.

## Decide which file

| Scope | File | Use when |
|-------|------|----------|
| **Every agent in a mesh** | `<mesh-root>/mesh/mcp.json` | shared tool (DB, files, Bitbucket) — **default** |
| **One agent only** | `<mesh-root>/<agent>/.mcp.json` | tool specific to that agent |

The active mesh here is `my-mesh/` → mesh-global file is `my-mesh/mesh/mcp.json`.

## Mode gate (the thing that bites)

`readEligibleServers` filters by the delegation `mode`:

- **`ask`** (what peers use via the bridge) → grants **only** servers marked `"x-agentmesh": { "readOnly": true }`.
- **`do`** → grants **zero** non-framework servers.
- **`native`** → grants all.

So: **omit the readOnly marker and ask-mode agents never see your server.** Mark read-oriented tools `readOnly: true`.

> ⚠️ `readOnly` is a **grant gate, not enforcement**. It controls *which mode* sees the server — it does NOT stop the server's write tools from being called. A server with mutating tools (create PR, write file) can still mutate when granted.

## Recipe

**stdio server:**
```json
"my-tool": {
  "type": "stdio",
  "command": "python",
  "args": ["C:/AI/MCP/my_tool/server.py"],
  "env": {},
  "x-agentmesh": { "readOnly": true }
}
```

**HTTP server** (e.g. Atlassian/Bitbucket — copy `url`/`headers` from `claude mcp get <name>`):
```json
"my-http-tool": {
  "type": "http",
  "url": "https://mcp.example.com/v1/mcp",
  "headers": { "Authorization": "Bearer ${MY_TOKEN}" },
  "x-agentmesh": { "readOnly": true }
}
```

The mesh passes the entry to `claude` **verbatim** via `--strict-mcp-config --mcp-config`; the only transform is stripping the `x-agentmesh` marker. Tool allowlisting (`mcp__<name>`) is automatic.

## Rules

- **Never** name a server `agentmesh_*` — reserved framework namespace, dropped from every source.
- **Credentials:** prefer `${ENV_VAR}` in headers over a literal token — `mcp.json` files are repo-tracked and a literal secret leaks. (Verify the deployed Claude Code build expands `${}` in `--mcp-config` headers; the mesh itself does no expansion. If unverified, an inline token works but is a known leak risk — flag it.)
- On a name collision, **agent-local wins** over mesh-global.

## Validate

```sh
node -e "const c=require('./my-mesh/mesh/mcp.json'); console.log('ok:', Object.keys(c.mcpServers).join(', '))"
```

Then confirm an agent sees it by running a real delegation in `ask` mode and checking the assembled config / that `mcp__<name>__*` tools are offered.

## Common mistakes

| Symptom | Cause |
|---------|-------|
| Agent can't see the server in `ask` mode | Missing `"x-agentmesh": { "readOnly": true }` |
| Server never appears in any mode | Delegated in `do` mode (grants no non-framework servers) |
| Name silently dropped | Used reserved `agentmesh_*` prefix |
| Token leaked in git | Inlined secret instead of `${ENV_VAR}` |
