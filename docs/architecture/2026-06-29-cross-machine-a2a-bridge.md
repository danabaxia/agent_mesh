# Cross-machine A2A bridge (box concierge → Mac mesh)

Lets the voice concierge on the Windows box reach agents running on the Mac mesh,
over A2A. **The framework already supports this** — `registry.json` peers may be
declared as HTTP peers via a `url` field (`src/a2a/registry.js`), and the
`HttpClientSession` (`src/a2a/http-client.js`) POSTs `SendMessage` to that url.
No framework change is needed; this is wiring + a test.

## Topology
```
📱 → box concierge ──ask_peer("coder", …)──▶ peer-bridge (ask-only, recursion/cost)
                                               ▼ HTTP A2A (HttpClientSession)
                                     box 127.0.0.1:<P>  ──reverse SSH tunnel (Mac-initiated)──▶  Mac 127.0.0.1:<Q>
                                                                                                  serve-a2a-http dev-mesh/coder
                                                                                                  → claude (the agent answers)
```
Mac-initiated reverse SSH (`ssh -R <P>:127.0.0.1:<Q> enoch-lan`) is used because macOS
firewall blocks inbound to the Mac and userspace Tailscale doesn't route inbound; Mac→box
SSH works. The `-R` listener binds on the box's loopback (Windows host, shared into WSL via
mirrored networking), so the WSL concierge reaches it at `127.0.0.1:<P>`.

## Wiring
1. **Mac:** serve the target agent — `serve-a2a-http dev-mesh/<agent> --port <Q>`.
2. **Tunnel (Mac):** `ssh -f -N -R <P>:127.0.0.1:<Q> enoch-lan`.
3. **Box concierge registry** (`dev-mesh/concierge/registry.json`, marker-validated):
   `{ "x-agentmesh-generated": true, "peers": { "<agent>": { "url": "http://127.0.0.1:<P>/rpc" } } }`
4. **Box concierge env:** the serving process needs `AGENT_MESH_MESH_ROOT` (or
   `AGENT_MESH_MESH_CEILING`) set to the mesh dir so the bridge can resolve the caller's
   unique manifest name (`resolveCallerName`) — normally stamped by `doctor`.

## Security / invariants (inherited, tested)
- **ask-only** onward delegation (the peer-bridge refuses non-ask before any send).
- **recursion + depth budget** threaded across the transport via `X-AgentMesh-Path/Depth`.
- **failure-as-data**: an unreachable/failed peer returns `ok:false`, never throws.
- registry must carry the `x-agentmesh-generated:true` marker (tampered/markerless → no peers).

## Test
`test/cross-machine-a2a.test.js` proves the full path hermetically: a caller agent with an
HTTP-peer registry delegates over a real http-client to a real booted `serve-a2a-http` agent
(stub claude) and the Task maps back; plus unreachable-peer-as-data and unknown-peer-refusal.
Transport is localhost (transport-equivalent to the tunnel).

## Operational prerequisite (NOT A2A)
The Mac agent runs `claude -p` to answer. As of 2026-06-29 **headless claude is "Not logged
in" Mac-wide** — this breaks the dev-society pipeline too, independent of the bridge. Fix:
re-auth claude for headless use (`claude setup-token` → set `CLAUDE_CODE_OAUTH_TOKEN` in the
agent server's env, or in the dev-society/bridge launchd `EnvironmentVariables`). Once headless
claude works, both the dev-society and this bridge answer live; the A2A transport is already proven.
