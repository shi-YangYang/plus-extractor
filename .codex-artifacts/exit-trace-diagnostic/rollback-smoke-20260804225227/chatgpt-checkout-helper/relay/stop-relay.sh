#!/usr/bin/env bash
set -euo pipefail

LABEL="com.plus-extractor.relay"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PID_FILE="$HOME/Library/Application Support/PlusExtractorRelay/relay.pid"

if [[ -f "$PLIST" ]]; then
  launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
fi

curl -fsS --max-time 2 -X POST http://127.0.0.1:17898/shutdown >/dev/null 2>&1 || true

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  case "$PID" in
    ''|*[!0-9]*) ;;
    *) kill "$PID" >/dev/null 2>&1 || true ;;
  esac
  rm -f "$PID_FILE"
fi

echo "RELAY_STOPPED"
