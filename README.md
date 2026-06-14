# agents_mesh

`agent-mesh` is a local-first dashboard and management layer for Claude CLI /
Claude Code agent workspaces, built on an A2A peer framework. The dashboard
lets you inspect a mesh of project folders, manage native Claude CLI sessions,
browse files, review skills/MCP resources, and watch activity/results from one
place.

Under the hood, each project folder can run an `agent-mesh` A2A stdio server.
A caller sends `SendMessage` to a peer folder and receives a structured A2A
`Task`. Peer writes are confined to the peer's own folder by a deterministic
path-guard hook, recursion is bounded, and there is no central broker.

The earlier MCP server remains as a compatibility surface. The current
framework direction, A2A contract, migration plan, and evaluation matrix live
in [`PROJECT.md`](PROJECT.md).

## What This Is

- Claude CLI dashboard management: inspect agents, files, skills, MCP servers,
  activity, results, and native Claude sessions from one browser UI.
- A2A peer framework: each agent folder can expose an `AgentCard`, receive
  `SendMessage`, and return an A2A `Task` through `serve-a2a`.
- Safety boundary: each peer is scoped to its own folder, write mode uses a
  path-guard hook, recursion is bounded, and the mesh does not depend on a
  central broker.

## Installation

`agent-mesh` is a zero-dependency Node CLI (Node **>= 20**). It ships as an npm
tarball and installs globally — no build step, no native modules.

```sh
# from a checkout (verifies Node, runs tests, packs, installs globally):
scripts/install.sh                 # macOS / Linux
./scripts/install.ps1              # Windows (PowerShell)

# or manually:
npm pack                           # → agent-mesh-<version>.tgz
npm install -g ./agent-mesh-*.tgz  # add --prefix ~/.local if you lack admin rights
agent-mesh --help                  # verify
```

To deploy to another machine, copy the `.tgz` over and run
`npm i -g ./agent-mesh-<version>.tgz` there. Full options (per-platform notes,
PATH setup, uninstall) are in [`INSTALL.md`](INSTALL.md).

## Usage

Start the dashboard for a mesh:

```sh
node ./bin/agent-mesh.js dashboard /path/to/mesh --no-open
node ./bin/agent-mesh.js dashboard /path/to/mesh --allow-shell --enable-chat
```

The default dashboard is read-only. Add `--allow-shell` only when the browser
should launch or mirror native Claude CLI sessions. Add `--enable-chat` when
you want the in-dashboard ask-only A2A chat composer.

Common mesh setup:

```sh
node ./bin/agent-mesh.js init-mesh ./my-mesh
node ./bin/agent-mesh.js add ./my-mesh /path/to/agent --name docs --modes ask,do --apply
node ./bin/agent-mesh.js dashboard ./my-mesh --no-open
```

Development and lower-level server entry points:

```sh
npm test
node ./bin/agent-mesh.js serve-a2a /path/to/project
node ./bin/agent-mesh.js serve /path/to/project   # MCP compatibility mode
```

`agent-mesh serve-a2a <folder>` starts a newline-delimited JSON-RPC server for
exactly one folder. It supports:

- `initialize`: returns the folder's A2A `AgentCard`.
- `ping`: health check.
- `SendMessage`: validates an A2A `Message`, runs the scoped delegate task,
  and returns an A2A `Task`.

Task mode is carried in `message.metadata["agentmesh/mode"]`:

- `ask`: read-only worker tools.
- `do`: structured write tools plus path-guard confinement to the peer root.

`agent-mesh serve <folder>` starts the compatibility MCP server. It exposes:

- `describe_self`: returns bounded `AGENT.md` metadata for the folder.
- `delegate_task`: validates `{ mode, task }`, checks the inherited recursion
  context, serializes runs per folder, spawns `claude -p`, logs the transcript,
  and returns the pinned result JSON.

The v1 `do` mode allows only structured write tools plus read tools; `Bash` is
not allowed. A PreToolUse hook checks each structured write path against the
server root after realpath canonicalization.

## A2A Client Example

```js
import { createA2AClient } from './src/a2a/stdio-client.js';

const client = await createA2AClient({
  knowledge: {
    root: '/path/to/agent-b',
    command: 'node',
    args: ['./bin/agent-mesh.js', 'serve-a2a', '/path/to/agent-b']
  }
});

const task = await client.send('knowledge', {
  messageId: 'm1',
  role: 'ROLE_USER',
  parts: [{ text: 'Inspect your local project.' }],
  metadata: { 'agentmesh/mode': 'ask' }
});

await client.close();
```

## Complex Demo

Run a deterministic App -> Library workflow that exercises the A2A structure
without requiring a real `claude` binary:

```sh
node scripts/complex-demo.mjs
```

The script creates a disposable workspace with an app folder (Agent A) and a
library folder (Agent B). A uses `createA2AClient` to spawn B with
`serve-a2a`, then runs:

- `initialize`: reads B's `AgentCard`.
- `SendMessage` `ask`: B answers a catalog question.
- `SendMessage` `do`: B changes its own `lib/strings.js`.
- `SendMessage` `ask`: B verifies the change.
- malformed `SendMessage`: B returns a rejected `Task` with
  `agentmesh/error_code: bad_input`.

Use JSON output for assertions or inspection:

```sh
node scripts/complex-demo.mjs --json
```

The demo uses a scripted worker for repeatability, but the transport, registry,
Task mapping, per-folder server lifecycle, change detection, logs, and
`ask`/`do` mode handling are the same framework path used by real delegated
workers.
