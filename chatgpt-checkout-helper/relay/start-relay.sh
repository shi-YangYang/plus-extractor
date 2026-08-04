#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PARENT="$(dirname "$0")"
SCRIPT_DIR="$(cd "$SCRIPT_PARENT" && pwd)"
RELAY_SCRIPT="$SCRIPT_DIR/local-relay.js"
NODE_BIN="$(command -v node || true)"
LABEL="com.plus-extractor.relay"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/PlusExtractorRelay"
STATE_DIR="$HOME/Library/Application Support/PlusExtractorRelay"
PID_FILE="$STATE_DIR/relay.pid"

if curl -fsS --max-time 1 http://127.0.0.1:17898/status 2>/dev/null | grep -q '"ready":true'; then
  echo "RELAY_ALREADY_RUNNING"
  echo "PROXY=127.0.0.1:17897"
  exit 0
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js runtime was not found" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$STATE_DIR"
if [[ -f "$PLIST" ]]; then
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  nohup "$NODE_BIN" "$RELAY_SCRIPT" >> "$LOG_DIR/relay.log" 2>> "$LOG_DIR/relay-error.log" &
  echo "$!" > "$PID_FILE"
fi

for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 http://127.0.0.1:17898/status 2>/dev/null | grep -q '"ready":true'; then
    echo "RELAY_STARTED"
    echo "PROXY=127.0.0.1:17897"
    exit 0
  fi
  sleep 0.125
done

echo "Relay process did not become ready; inspect $LOG_DIR/relay-error.log" >&2
exit 1
