#!/usr/bin/env bash
# agent-mesh installer (macOS / Linux).
#
# Builds the npm tarball from this checkout and installs the `agent-mesh` CLI
# globally — the same artifact you would distribute and `npm i -g`. No build
# step, no dependencies (the package is zero-dep, Node >= 20).
#
# Usage:
#   scripts/install.sh            # pack + global install + verify
#   scripts/install.sh --pack     # only produce the .tgz (no global install)
#   scripts/install.sh --no-test  # skip the test gate before installing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PACK_ONLY=0
RUN_TESTS=1
for arg in "$@"; do
  case "$arg" in
    --pack) PACK_ONLY=1 ;;
    --no-test) RUN_TESTS=0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# 1. Preflight: Node >= 20.
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH. Install Node >= 20 first." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: Node >= 20 required (found $(node -v))." >&2; exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is not on PATH." >&2; exit 1
fi
echo "✓ node $(node -v), npm $(npm -v)"

# 2. Test gate (hermetic; stubs the claude binary).
if [ "$RUN_TESTS" -eq 1 ]; then
  echo "→ running test suite (npm test)…"
  npm test
  echo "✓ tests passed"
fi

# 3. Pack the publishable tarball (honors package.json "files").
echo "→ npm pack…"
TARBALL="$(npm pack 2>/dev/null | tail -1)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "error: npm pack did not produce a tarball." >&2; exit 1
fi
echo "✓ packed $TARBALL"

if [ "$PACK_ONLY" -eq 1 ]; then
  echo "Tarball ready: $REPO_ROOT/$TARBALL"
  echo "Distribute it, then on the target machine:  npm i -g <tarball>"
  exit 0
fi

# 4. Global install of the exact packed artifact.
echo "→ npm install -g $TARBALL…"
npm install -g "$TARBALL"

# 5. Verify the CLI resolved on PATH.
if ! command -v agent-mesh >/dev/null 2>&1; then
  echo "warning: 'agent-mesh' is installed but not on PATH." >&2
  echo "Add npm's global bin to PATH:  export PATH=\"\$(npm prefix -g)/bin:\$PATH\"" >&2
  exit 0
fi
echo "✓ installed: $(command -v agent-mesh)"
agent-mesh --help >/dev/null 2>&1 && echo "✓ agent-mesh --help OK"

cat <<'NEXT'

Done. Next steps:
  agent-mesh init-mesh <folder>          # create a mesh root
  agent-mesh add <mesh> <agent-folder>   # register an agent
  agent-mesh dashboard <mesh> --allow-shell   # launch the dashboard
NEXT
