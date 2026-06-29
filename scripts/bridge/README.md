# Cross-machine A2A bridge

Reproducible setup for letting the **voice concierge on the Windows GPU box**
delegate to **agents in the Mac's dev-society mesh** over A2A — so a phone voice
command (`📱 → STT → concierge → ask_peer → Mac agent → relayed reply → TTS → 📱`)
reaches the real `coder` / `tester` / `analyst` running on the Mac.

The framework already supports this with **zero code changes**: `registry.json`
peers may be HTTP peers (a `url` field; `src/a2a/registry.js` `normalizeRegistry`),
and `HttpClientSession` POSTs `SendMessage` to that URL. So the bridge is pure
wiring — these two scripts make that wiring reproducible instead of hand-built.

## Topology

```
  📱 phone ──voice──▶  Windows box (WSL)                         Mac (dev-society mesh)
                       ├─ voice runtime (STT/TTS)                ├─ serve-a2a-http coder   :8790
                       └─ concierge (serve-a2a-http)             ├─ serve-a2a-http tester  :8792
                            │ ask_peer(coder|tester|analyst)     └─ serve-a2a-http analyst :8794
                            ▼                                              ▲
                          registry.json HTTP peers                        │ ssh -R (reverse tunnel)
                          http://127.0.0.1:879x/rpc  ───────────tunnel─────┘
```

**Why a Mac-initiated reverse tunnel.** The box can't dial in to the Mac (firewall
blocks inbound; userspace Tailscale doesn't route inbound). But Mac→box SSH works.
`ssh -R BOXPORT:127.0.0.1:MACPORT` binds the listener on the **box's** loopback,
which WSL shares via mirrored networking — so the WSL concierge reaches the Mac
agent at `127.0.0.1:BOXPORT`. The Mac drives the connection; launchd `KeepAlive`
+ SSH keepalives reconnect it.

## Default port map

| Agent   | Mac port (served) | Box port (tunnel + registry) |
|---------|-------------------|------------------------------|
| coder   | 8790              | 8791                         |
| tester  | 8792              | 8793                         |
| analyst | 8794              | 8795                         |

`BOXPORT = MACPORT + PORT_STRIDE` (stride 1). Keep the Mac `AGENTS` and box
`PEERS` lists in sync — same names, box port = Mac port + stride.

## Setup

### 1. Mac

```sh
# defaults match the live deployment; override via env if your paths/ports differ
scripts/bridge/mac-bridge-setup.sh
```

Builds `~/.agent-mesh/bridge/{serve-agents.sh,tunnel.sh}` and loads two launchd
jobs (`…bridge-agents`, `…bridge-tunnel`, both `KeepAlive`).

**Headless-claude auth (required, one-time).** A detached/launchd `claude -p` is
`Not logged in` unless `CLAUDE_CODE_OAUTH_TOKEN` is set — interactive auth doesn't
survive a detached spawn. In a **real terminal** (the TUI needs a TTY — don't
background it):

```sh
claude setup-token        # paste the sk-ant-oat… value into ~/.agent-mesh/bridge/.claude-token
launchctl kickstart -k gui/$UID/com.danabaxia.agent-mesh.bridge-agents
```

### 2. Box (run inside WSL on the Windows machine)

```sh
scripts/bridge/box-bridge-setup.sh
```

Writes the concierge `registry.json` (HTTP peers + trust marker) and patches the
concierge supervisor to export `AGENT_MESH_MESH_ROOT` + `AGENT_MESH_MESH_CEILING`
(needed by `resolveCallerName` for `ask_peer`), then restarts the supervisor.

> **Gotcha:** patching the supervisor file isn't enough — the *running* supervisor
> holds the old script in memory. The script `pkill`s it so its keeper respawns it
> with the new env. (Restart the *supervisor*, not just the child server.)

## Verify

From the box, each peer should ping over the tunnel:

```sh
curl -s -X POST http://127.0.0.1:8793/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'        # tester -> {"jsonrpc":"2.0","id":1,"result":{}}
```

End-to-end, the concierge's `ask_peer("tester")` returns the real agent's answer,
which the brain relays to the phone.

## Config knobs

| Script | Env | Default |
|--------|-----|---------|
| mac | `DEPLOY_DIR` | `~/.agent-mesh/deploy` (checkout with `bin/agent-mesh.js` + `dev-mesh/`) |
| mac | `BOX_SSH` | `enoch-lan` |
| mac | `AGENTS` | `coder:8790 tester:8792 analyst:8794` (name:MACPORT) |
| mac | `PORT_STRIDE` | `1` |
| mac | `TOKEN_FILE` | `~/.agent-mesh/bridge/.claude-token` |
| box | `MESH_DIR` | `/opt/voice/agent-mesh/dev-mesh` |
| box | `SUPERVISOR` | `/opt/voice/concierge-a2a.sh` |
| box | `PEERS` | `coder:8791 tester:8793 analyst:8795` (name:BOXPORT) |

## Add / remove a bridged agent

1. Mac: add `name:MACPORT` to `AGENTS`, re-run `mac-bridge-setup.sh`.
2. Box: add the matching `name:BOXPORT` to `PEERS`, re-run `box-bridge-setup.sh`.

Both scripts are idempotent — re-running regenerates the scripts/registry and
reloads the services.

## Tests

The transport this bridge relies on is covered hermetically by
`test/cross-machine-a2a.test.js` (real http-client → real booted `serve-a2a-http`
remote agent with a stub `claude`, via a marker-validated HTTP-peer registry;
unreachable peer → data, not crash; unknown peer refused before the network).
These setup scripts are operational glue (they wire existing, tested machinery),
so they have no separate unit gate.

## Caveats

- **dev-society token:** a manual `dev-society-deploy-install.sh` rewrites the
  daemon's launchd plist and would drop `CLAUDE_CODE_OAUTH_TOKEN`. Re-add it, or
  point that installer at `~/.agent-mesh/bridge/.claude-token`.
- The bridge is **ask-only** onward delegation (the peer-bridge enforces it); no
  agent writes across the tunnel.
