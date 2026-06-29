#!/usr/bin/env bash
# box-bridge-setup.sh — reproduce the BOX half of the cross-machine A2A bridge.
#
# Run this ON THE BOX (the Windows GPU machine, inside WSL). It does two things the
# concierge needs to reach the Mac's agents over the reverse SSH tunnel:
#
#   1. Writes the concierge's registry.json with one marker-validated HTTP peer per
#      bridged agent, pointed at its tunnel port (http://127.0.0.1:BOXPORT/rpc).
#      `x-agentmesh-generated:true` is the trust marker readManagedRegistry requires
#      before the peer-bridge will delegate to a peer.
#
#   2. Patches the concierge supervisor so the SERVING process exports
#      AGENT_MESH_MESH_ROOT + AGENT_MESH_MESH_CEILING = the mesh dir. Without
#      MESH_CEILING, resolveCallerName refuses ask_peer with "cannot resolve a
#      unique caller name" (normally doctor stamps this; the box concierge isn't
#      doctor-wired).
#
# The Mac half (serving + the reverse tunnel) is set up by mac-bridge-setup.sh. See README.md.
#
# GOTCHA: patching the supervisor FILE is not enough — the running supervisor holds the
# old script in memory. This script restarts it (pkill) so the patch takes effect.
#
# Config via env (defaults match the live box deployment):
#   MESH_DIR     /opt/voice/agent-mesh/dev-mesh   the mesh root on the box
#   CONCIERGE    $MESH_DIR/concierge              the concierge agent folder
#   SUPERVISOR   /opt/voice/concierge-a2a.sh      the script that serves the concierge
#   PEERS        "coder:8791 tester:8793 analyst:8795"   name:BOXPORT (must match the tunnel)
set -euo pipefail

MESH_DIR="${MESH_DIR:-/opt/voice/agent-mesh/dev-mesh}"
CONCIERGE="${CONCIERGE:-$MESH_DIR/concierge}"
SUPERVISOR="${SUPERVISOR:-/opt/voice/concierge-a2a.sh}"
PEERS="${PEERS:-coder:8791 tester:8793 analyst:8795}"

die() { echo "ERROR: $*" >&2; exit 1; }
[ -d "$CONCIERGE" ] || die "concierge folder not at $CONCIERGE; set CONCIERGE or MESH_DIR"

# --- 1. registry.json (marker + one HTTP peer per agent) ----------------------------------
REGISTRY="$CONCIERGE/registry.json"
{
  echo '{'
  echo '  "x-agentmesh-generated": true,'
  echo '  "peers": {'
  first=1
  for pair in $PEERS; do
    name="${pair%%:*}"; bport="${pair##*:}"
    [ $first -eq 1 ] || echo '    ,'
    first=0
    printf '    "%s": { "url": "http://127.0.0.1:%s/rpc" }\n' "$name" "$bport"
  done
  echo '  }'
  echo '}'
} > "$REGISTRY"
echo "WROTE  $REGISTRY"

# --- 2. supervisor MESH_ROOT/CEILING patch (idempotent) -----------------------------------
if [ -f "$SUPERVISOR" ]; then
  if grep -q 'AGENT_MESH_MESH_CEILING' "$SUPERVISOR"; then
    echo "KEEP   $SUPERVISOR (already exports MESH_CEILING)"
  else
    # Insert the two exports right after the shebang line.
    tmp="$(mktemp)"
    {
      head -n1 "$SUPERVISOR"
      echo "export AGENT_MESH_MESH_ROOT=\"$MESH_DIR\"      # added by box-bridge-setup.sh"
      echo "export AGENT_MESH_MESH_CEILING=\"$MESH_DIR\"   # so resolveCallerName works for ask_peer"
      tail -n +2 "$SUPERVISOR"
    } > "$tmp"
    cat "$tmp" > "$SUPERVISOR"
    rm -f "$tmp"
    echo "PATCH  $SUPERVISOR (added MESH_ROOT + MESH_CEILING exports)"
  fi
  # The running supervisor holds the old script in memory — restart it so the patch + new
  # registry take effect. launchd/systemd/its own loop should respawn it.
  if pkill -f "$(basename "$SUPERVISOR")" 2>/dev/null; then
    echo "KICK   restarted supervisor ($(basename "$SUPERVISOR")) — its keeper will respawn it"
  else
    echo "NOTE   supervisor not currently running; start it via your service manager"
  fi
else
  echo "WARN   supervisor not found at $SUPERVISOR — set SUPERVISOR, or ensure your"
  echo "       concierge server exports AGENT_MESH_MESH_ROOT and AGENT_MESH_MESH_CEILING=$MESH_DIR"
fi

echo ""
echo "=== Box bridge ready ==="
echo "Concierge peers (must match the Mac tunnel's box ports):"
for pair in $PEERS; do
  echo "  ${pair%%:*} -> http://127.0.0.1:${pair##*:}/rpc"
done
echo ""
echo "Verify each peer is reachable over the tunnel, e.g.:"
for pair in $PEERS; do
  echo "  curl -s -X POST http://127.0.0.1:${pair##*:}/rpc -H 'content-type: application/json' \\"
  echo "    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}'   # ${pair%%:*}  -> {\"result\":{}}"
done
