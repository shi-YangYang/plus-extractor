#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PARENT="$(dirname "$0")"
SCRIPT_DIR="$(cd "$SCRIPT_PARENT" && pwd)"
LABEL="com.plus-extractor.relay"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

bash "$SCRIPT_DIR/stop-relay.sh"
launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "AUTOSTART_REMOVED=$PLIST"
