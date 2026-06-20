#!/usr/bin/env bash
# Cutover/install for the deploy-worktree daemon. Run from INSIDE the deploy worktree.
# Build+stage: --dry-run prints everything and touches nothing. Live mode pins the
# deploy root to this script's location and refuses an external override.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ "$DRY_RUN" = "1" ]; then
  DEPLOY_ROOT="${DEV_SOCIETY_DEPLOY_ROOT:-$DEPLOY_ROOT_DEFAULT}"
else
  DEPLOY_ROOT="$DEPLOY_ROOT_DEFAULT"
  if [ -n "${DEV_SOCIETY_DEPLOY_ROOT:-}" ] && [ "$DEV_SOCIETY_DEPLOY_ROOT" != "$DEPLOY_ROOT" ]; then
    echo "error: DEV_SOCIETY_DEPLOY_ROOT ($DEV_SOCIETY_DEPLOY_ROOT) != script root ($DEPLOY_ROOT) — refusing in live mode" >&2
    exit 1
  fi
fi

LABEL="com.danabaxia.agent-mesh.dev-society"
SYNC_LABEL="com.danabaxia.agent-mesh.deploy-sync"
DASH_LABEL="com.danabaxia.agent-mesh.dashboard"
LEGACY_LABEL="com.danabaxia.dev-society"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH — cannot write a valid daemon plist" >&2
  exit 1
fi
CLAUDE_BIN="$(command -v claude || true)"
GH_BIN="$(command -v gh || true)"
UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"

# Build PATH_ENV: include dirs for node/claude/gh when found, plus standard dirs, de-duplicated.
_path_parts=""
_add_dir() {
  local d="$1"
  [ -z "$d" ] && return
  case ":$_path_parts:" in
    *":$d:"*) ;;  # already present
    *) _path_parts="${_path_parts:+$_path_parts:}$d" ;;
  esac
}
_add_dir "$(dirname "$NODE_BIN")"
[ -n "$CLAUDE_BIN" ] && _add_dir "$(dirname "$CLAUDE_BIN")"
[ -n "$GH_BIN" ]     && _add_dir "$(dirname "$GH_BIN")"
_add_dir "/usr/local/bin"
_add_dir "/opt/homebrew/bin"
_add_dir "/usr/bin"
_add_dir "/bin"
_add_dir "/usr/sbin"
_add_dir "/sbin"
PATH_ENV="$_path_parts"

REPO="${DEV_SOCIETY_REPO:-}"

daemon_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEPLOY_ROOT/scripts/dev-society-daemon.mjs</string></array>
  <key>WorkingDirectory</key><string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>${USER:-$(id -un)}</string>
    <key>DEV_SOCIETY_REPO</key><string>$REPO</string>
$([ -n "$CLAUDE_BIN" ] && printf '    <key>AGENT_MESH_CLAUDE</key><string>%s</string>\n' "$CLAUDE_BIN")  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/daemon.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/daemon.err.log</string>
</dict></plist>
PLIST
}

sync_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SYNC_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEPLOY_ROOT/scripts/dev-society-deploy-sync.mjs</string></array>
  <key>WorkingDirectory</key><string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>${USER:-$(id -un)}</string>
    <key>DEV_SOCIETY_REPO</key><string>$REPO</string>
    <key>DEV_SOCIETY_DAEMON_LABEL</key><string>$LABEL</string>
    <key>DEV_SOCIETY_DASHBOARD_LABEL</key><string>$DASH_LABEL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/deploy-sync.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/deploy-sync.err.log</string>
</dict></plist>
PLIST
}

dashboard_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DASH_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEPLOY_ROOT/bin/agent-mesh.js</string><string>dashboard</string><string>$DEPLOY_ROOT/dev-mesh</string><string>--no-open</string><string>--port</string><string>7077</string></array>
  <key>WorkingDirectory</key><string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>${USER:-$(id -un)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/dashboard.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/dashboard.err.log</string>
</dict></plist>
PLIST
}

# Repoint a service: bootout the old, then bring up the new with a `load -w` fallback.
# `bootstrap` is the modern API but fails with `5: Input/output error` outside a GUI
# login session; legacy `launchctl load -w` succeeds there. On a total failure, restore
# the previous plist (saved as <plist>.prev by the caller) and re-load it. NOTE: this
# rollback only helps when the new plist content is malformed; if the launchd environment
# itself is broken (EIO outside a GUI session), the rollback also fails and the daemon
# remains down. See memory dev-society-247-launchd.
reload() {   # $1 = label, $2 = plist path
  local label="$1" plist="$2" backup="$2.prev"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null; then
    :
  elif launchctl load -w "$plist" 2>/dev/null; then
    echo "note: 'launchctl bootstrap' failed (EIO outside a GUI session?); used 'launchctl load -w' for $label" >&2
  else
    echo "error: could not start $label via 'launchctl bootstrap' or 'launchctl load -w'" >&2
    if [ -f "$backup" ]; then
      echo "rolling back $label to its previous plist (restores on plist-content errors; launchd environment errors will still leave the daemon down)" >&2
      cp "$backup" "$plist"
      launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null || launchctl load -w "$plist" 2>/dev/null || true
    else
      echo "hint: run from a GUI Terminal/login session, or manually: launchctl load -w \"$plist\"" >&2
    fi
    return 1
  fi
  launchctl enable "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl kickstart -k "gui/$UID_NUM/$label" 2>/dev/null || true
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] DEPLOY_ROOT=$DEPLOY_ROOT"
  echo "[dry-run] write $LA_DIR/$LABEL.plist:"; daemon_plist
  echo "[dry-run] write $LA_DIR/$SYNC_LABEL.plist:"; sync_plist
  echo "[dry-run] stage plists before any bootout (backup prior plist to <plist>.prev for rollback)"
  echo "[dry-run] write $LA_DIR/$DASH_LABEL.plist:"; dashboard_plist
  echo "[dry-run] reload daemon: launchctl bootout gui/$UID_NUM/$LABEL || true; bootstrap (fallback: launchctl load -w); enable; kickstart -k"
  echo "[dry-run] reload sync:   launchctl bootout gui/$UID_NUM/$SYNC_LABEL || true; bootstrap (fallback: launchctl load -w); enable; kickstart -k"
  echo "[dry-run] reload dashboard: launchctl bootout gui/$UID_NUM/$DASH_LABEL || true; bootstrap (fallback: launchctl load -w); enable; kickstart -k"
  echo "[dry-run] on start failure: roll back to <plist>.prev and re-load (restores on plist-content errors; launchd environment errors leave the daemon down)"
  echo "[dry-run] dedupe legacy: launchctl bootout gui/$UID_NUM/$LEGACY_LABEL || true; rm -f $LA_DIR/$LEGACY_LABEL.plist"
  exit 0
fi

# Live-mode preflight: require DEV_SOCIETY_REPO and claude BEFORE any side effect.
if [ -z "$REPO" ]; then
  echo "error: DEV_SOCIETY_REPO=owner/repo is required for live install" >&2
  exit 1
fi
if [ -z "$CLAUDE_BIN" ]; then
  echo "error: claude not found on PATH — the daemon needs it" >&2
  exit 1
fi

mkdir -p "$LA_DIR" "$DEPLOY_ROOT/.dev-society"
# Clean up .plist.prev backup files on exit (success, error, or interrupt) so they
# never linger on disk after a partial/aborted install.
trap 'rm -f "$LA_DIR/$LABEL.plist.prev" "$LA_DIR/$SYNC_LABEL.plist.prev" "$LA_DIR/$DASH_LABEL.plist.prev"' EXIT
# Stage every plist BEFORE any bootout; back up the prior plist so reload() can roll
# back to the previous plist on start failure (restores on plist-content errors; a brief
# down window still exists between bootout and bootstrap/load, and launchd environment
# errors such as EIO outside a GUI session will leave the daemon down regardless).
for _lbl in "$LABEL" "$SYNC_LABEL" "$DASH_LABEL"; do
  [ -f "$LA_DIR/$_lbl.plist" ] && cp "$LA_DIR/$_lbl.plist" "$LA_DIR/$_lbl.plist.prev"
done
daemon_plist    > "$LA_DIR/$LABEL.plist"
sync_plist      > "$LA_DIR/$SYNC_LABEL.plist"
dashboard_plist > "$LA_DIR/$DASH_LABEL.plist"
reload "$LABEL"      "$LA_DIR/$LABEL.plist"
reload "$SYNC_LABEL" "$LA_DIR/$SYNC_LABEL.plist"
reload "$DASH_LABEL" "$LA_DIR/$DASH_LABEL.plist"
launchctl bootout "gui/$UID_NUM/$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LA_DIR/$LEGACY_LABEL.plist"
echo "installed daemon + deploy-sync + dashboard from $DEPLOY_ROOT; removed legacy $LEGACY_LABEL"
