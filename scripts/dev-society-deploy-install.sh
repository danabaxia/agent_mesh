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
LEGACY_LABEL="com.danabaxia.dev-society"
NODE_BIN="$(command -v node)"
UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"
PATH_ENV="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE_BIN")"
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
  </dict>
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
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/deploy-sync.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/deploy-sync.err.log</string>
</dict></plist>
PLIST
}

reload() {   # $1 = label, $2 = plist path  (bootout then bootstrap — required to repoint)
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$2"
  launchctl enable "gui/$UID_NUM/$1"
  launchctl kickstart -k "gui/$UID_NUM/$1"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] DEPLOY_ROOT=$DEPLOY_ROOT"
  echo "[dry-run] write $LA_DIR/$LABEL.plist:"; daemon_plist
  echo "[dry-run] write $LA_DIR/$SYNC_LABEL.plist:"; sync_plist
  echo "[dry-run] reload daemon: launchctl bootout gui/$UID_NUM/$LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] reload sync:   launchctl bootout gui/$UID_NUM/$SYNC_LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] dedupe legacy: launchctl bootout gui/$UID_NUM/$LEGACY_LABEL || true; rm -f $LA_DIR/$LEGACY_LABEL.plist"
  exit 0
fi

mkdir -p "$LA_DIR" "$DEPLOY_ROOT/.dev-society"
daemon_plist > "$LA_DIR/$LABEL.plist"
sync_plist  > "$LA_DIR/$SYNC_LABEL.plist"
reload "$LABEL"      "$LA_DIR/$LABEL.plist"
reload "$SYNC_LABEL" "$LA_DIR/$SYNC_LABEL.plist"
launchctl bootout "gui/$UID_NUM/$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LA_DIR/$LEGACY_LABEL.plist"
echo "installed daemon + deploy-sync from $DEPLOY_ROOT; removed legacy $LEGACY_LABEL"
