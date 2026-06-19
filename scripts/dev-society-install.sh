#!/usr/bin/env bash
# scripts/dev-society-install.sh — set up the persistent A2A Dev-Society daemon to run 24/7
# under your OS process manager, so it survives logout/reboot and restarts on crash.
#
#   macOS  -> launchd LaunchAgent  (~/Library/LaunchAgents/<label>.plist, GUI session)
#   Linux  -> systemd user service (~/.config/systemd/user/<name>.service, lingering)
#
# The unit file is GENERATED from detected paths at install time, so nothing
# machine-specific is committed. See dev-mesh/DEPLOY-A2A-SOCIETY.md for the full model.
#
# Usage:
#   DEV_SOCIETY_REPO=owner/repo scripts/dev-society-install.sh install     # daemon + daily report (default)
#   scripts/dev-society-install.sh install-report                          # just the daily-report schedule
#   scripts/dev-society-install.sh status                                  # show state / pid
#   scripts/dev-society-install.sh logs                                    # tail the daemon log
#   scripts/dev-society-install.sh restart                                 # restart now
#   scripts/dev-society-install.sh uninstall                               # stop + remove both units
#
# Env (read at install time; persisted into the unit):
#   DEV_SOCIETY_REPO     owner/repo            (required to install)
#   DEV_SOCIETY_BASE     base branch           (default: main)
#   DEV_SOCIETY_POLL_MS  poll interval ms      (default: 60000)
#   DAILY_REPORT_HOUR    daily report hour     (default: 8 — local time)
#   AGENT_MESH_CLAUDE    claude binary         (default: claude on PATH)

set -euo pipefail

LABEL="com.danabaxia.agent-mesh.dev-society"   # launchd label / systemd unit base name
SERVICE="dev-society-daemon"                    # systemd unit name -> dev-society-daemon.service

# ── resolve repo + tool paths (the unit needs absolute paths; managers run with a bare env) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
DAEMON="$REPO_ROOT/scripts/dev-society-daemon.mjs"
LOG_DIR="$REPO_ROOT/.dev-society"
OUT_LOG="$LOG_DIR/daemon.out.log"
ERR_LOG="$LOG_DIR/daemon.err.log"

# Daily Mesh Report — a calendar-scheduled (not KeepAlive) unit that posts the digest once a day.
REPORT_LABEL="com.danabaxia.agent-mesh.dev-society-report"
REPORT_SERVICE="dev-society-report"
REPORT_SCRIPT="$REPO_ROOT/scripts/daily-report.mjs"
REPORT_HOUR="${DAILY_REPORT_HOUR:-8}"
REPORT_OUT="$LOG_DIR/daily-report.out.log"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found on PATH" >&2; exit 1; }; }

resolve_paths() {
  need node; need git
  NODE_BIN="$(command -v node)"
  GIT_BIN="$(command -v git)"
  GH_BIN="$(command -v gh || true)"
  CLAUDE_BIN="$(command -v "${AGENT_MESH_CLAUDE:-claude}" || true)"
  # Build a PATH that includes every tool dir the daemon shells out to (node/git/gh/claude).
  RUN_PATH="$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN")"
  [ -n "$GH_BIN" ] && RUN_PATH="$RUN_PATH:$(dirname "$GH_BIN")"
  [ -n "$CLAUDE_BIN" ] && RUN_PATH="$RUN_PATH:$(dirname "$CLAUDE_BIN")"
  RUN_PATH="$RUN_PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

preflight() {
  resolve_paths
  [ -n "${DEV_SOCIETY_REPO:-}" ] || { echo "error: DEV_SOCIETY_REPO=owner/repo is required to install" >&2; exit 1; }
  [ -f "$DAEMON" ] || { echo "error: daemon not found at $DAEMON" >&2; exit 1; }
  [ -n "$GH_BIN" ] || echo "warning: 'gh' CLI not found — the daemon needs it for live mode (issues/PRs)" >&2
  [ -n "$CLAUDE_BIN" ] || echo "warning: 'claude' CLI not found — the daemon needs it to drive the mesh" >&2
  BASE="${DEV_SOCIETY_BASE:-main}"
  POLL="${DEV_SOCIETY_POLL_MS:-60000}"
  mkdir -p "$LOG_DIR"
  echo "Self-test (proves wiring, no GitHub/claude calls):"
  ( cd "$REPO_ROOT" && DEV_SOCIETY_REPO="$DEV_SOCIETY_REPO" "$NODE_BIN" "$DAEMON" --selftest ) || {
    echo "error: daemon --selftest failed; aborting install" >&2; exit 1; }
}

# ════════════════════════════════ macOS / launchd ════════════════════════════════
plist_path() { echo "$HOME/Library/LaunchAgents/$LABEL.plist"; }
gui_target() { echo "gui/$(id -u)/$LABEL"; }

macos_install() {
  preflight
  local plist; plist="$(plist_path)"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DAEMON</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>$HOME</string>
        <key>USER</key><string>$(id -un)</string>
        <key>PATH</key><string>$RUN_PATH</string>
        <key>DEV_SOCIETY_REPO</key><string>$DEV_SOCIETY_REPO</string>
        <key>DEV_SOCIETY_BASE</key><string>$BASE</string>
        <key>DEV_SOCIETY_POLL_MS</key><string>$POLL</string>
$( [ -n "$CLAUDE_BIN" ] && printf '        <key>AGENT_MESH_CLAUDE</key><string>%s</string>\n' "$CLAUDE_BIN" )
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>$OUT_LOG</string>
    <key>StandardErrorPath</key><string>$ERR_LOG</string>
</dict>
</plist>
PLIST
  local tgt; tgt="$(gui_target)"
  launchctl bootout "$tgt" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "$tgt" 2>/dev/null || true
  launchctl kickstart -p "$tgt" || true
  echo "installed launchd agent: $tgt"
  echo "  plist: $plist"
  macos_status
}

macos_status() { launchctl print "$(gui_target)" 2>/dev/null | grep -E 'state =|pid =|last exit' || echo "not loaded"; }
macos_restart() { launchctl kickstart -k "$(gui_target)"; echo "restarted"; }
macos_uninstall() {
  launchctl bootout "$(gui_target)" 2>/dev/null || true
  rm -f "$(plist_path)"
  echo "uninstalled launchd agent and removed $(plist_path)"
}

macos_install_report() {
  preflight
  [ -f "$REPORT_SCRIPT" ] || { echo "error: daily-report not found at $REPORT_SCRIPT" >&2; exit 1; }
  local plist="$HOME/Library/LaunchAgents/$REPORT_LABEL.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$REPORT_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$NODE_BIN</string><string>$REPORT_SCRIPT</string><string>--post</string></array>
    <key>WorkingDirectory</key><string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>$HOME</string>
        <key>USER</key><string>$(id -un)</string>
        <key>PATH</key><string>$RUN_PATH</string>
        <key>DEV_SOCIETY_REPO</key><string>$DEV_SOCIETY_REPO</string>
$( [ -n "$CLAUDE_BIN" ] && printf '        <key>AGENT_MESH_CLAUDE</key><string>%s</string>\n' "$CLAUDE_BIN" )
    </dict>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>$REPORT_HOUR</integer><key>Minute</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>$REPORT_OUT</string>
    <key>StandardErrorPath</key><string>$REPORT_OUT</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$REPORT_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed daily-report LaunchAgent (${REPORT_HOUR}:00 local): $plist"
}

macos_uninstall_report() {
  launchctl bootout "gui/$(id -u)/$REPORT_LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$REPORT_LABEL.plist"
  echo "removed daily-report LaunchAgent"
}

# ════════════════════════════════ Linux / systemd --user ═════════════════════════
unit_path() { echo "$HOME/.config/systemd/user/$SERVICE.service"; }

linux_install() {
  preflight
  need systemctl
  local unit; unit="$(unit_path)"
  mkdir -p "$(dirname "$unit")"
  local claude_env=""
  [ -n "$CLAUDE_BIN" ] && claude_env="Environment=AGENT_MESH_CLAUDE=$CLAUDE_BIN"
  cat > "$unit" <<UNIT
[Unit]
Description=Agent-mesh A2A Dev-Society daemon (24/7)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
Environment=HOME=$HOME
Environment=PATH=$RUN_PATH
Environment=DEV_SOCIETY_REPO=$DEV_SOCIETY_REPO
Environment=DEV_SOCIETY_BASE=$BASE
Environment=DEV_SOCIETY_POLL_MS=$POLL
$claude_env
ExecStart=$NODE_BIN $DAEMON
Restart=always
RestartSec=30
StandardOutput=append:$OUT_LOG
StandardError=append:$ERR_LOG

[Install]
WantedBy=default.target
UNIT
  # Survive logout (run without an active login session).
  loginctl enable-linger "$(id -un)" 2>/dev/null || \
    echo "note: could not enable lingering; daemon may stop on logout (run: sudo loginctl enable-linger $(id -un))"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE.service"
  echo "installed systemd user service: $SERVICE.service"
  echo "  unit: $unit"
  linux_status
}

linux_status() { systemctl --user status "$SERVICE.service" --no-pager 2>/dev/null | head -8 || echo "not loaded"; }
linux_restart() { systemctl --user restart "$SERVICE.service"; echo "restarted"; }
linux_uninstall() {
  systemctl --user disable --now "$SERVICE.service" 2>/dev/null || true
  rm -f "$(unit_path)"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "uninstalled systemd user service and removed $(unit_path)"
}

linux_install_report() {
  preflight; need systemctl
  [ -f "$REPORT_SCRIPT" ] || { echo "error: daily-report not found at $REPORT_SCRIPT" >&2; exit 1; }
  local svc="$HOME/.config/systemd/user/$REPORT_SERVICE.service"
  local tmr="$HOME/.config/systemd/user/$REPORT_SERVICE.timer"
  mkdir -p "$(dirname "$svc")"
  cat > "$svc" <<UNIT
[Unit]
Description=Daily Mesh Report
[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
Environment=HOME=$HOME
Environment=PATH=$RUN_PATH
Environment=DEV_SOCIETY_REPO=$DEV_SOCIETY_REPO
ExecStart=$NODE_BIN $REPORT_SCRIPT --post
StandardOutput=append:$REPORT_OUT
StandardError=append:$REPORT_OUT
UNIT
  cat > "$tmr" <<UNIT
[Unit]
Description=Run the Daily Mesh Report at ${REPORT_HOUR}:00
[Timer]
OnCalendar=*-*-* ${REPORT_HOUR}:00:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$REPORT_SERVICE.timer"
  echo "installed daily-report timer (${REPORT_HOUR}:00): $tmr"
}

linux_uninstall_report() {
  systemctl --user disable --now "$REPORT_SERVICE.timer" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$REPORT_SERVICE.service" "$HOME/.config/systemd/user/$REPORT_SERVICE.timer"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "removed daily-report timer"
}

# ════════════════════════════════ dispatch ═══════════════════════════════════════
OS="$(uname -s)"
CMD="${1:-install}"

case "$OS" in
  Darwin) PFX=macos ;;
  Linux)  PFX=linux ;;
  *) echo "error: unsupported OS '$OS' — use the manual steps in dev-mesh/DEPLOY-A2A-SOCIETY.md" >&2; exit 1 ;;
esac

case "$CMD" in
  install)        "${PFX}_install"; "${PFX}_install_report" ;;
  install-report) "${PFX}_install_report" ;;
  uninstall)      "${PFX}_uninstall"; "${PFX}_uninstall_report" ;;
  status)         "${PFX}_status" ;;
  restart)        "${PFX}_restart" ;;
  logs)           echo "== $OUT_LOG =="; tail -n 40 -f "$OUT_LOG" ;;
  *) echo "usage: $0 {install|install-report|uninstall|status|restart|logs}" >&2; exit 2 ;;
esac
