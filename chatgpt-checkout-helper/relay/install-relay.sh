#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PARENT="$(dirname "$0")"
SCRIPT_DIR="$(cd "$SCRIPT_PARENT" && pwd)"
RELAY_SCRIPT="$SCRIPT_DIR/local-relay.js"
NODE_BIN="$(command -v node || true)"
LABEL="com.plus-extractor.relay"
DOMAIN="gui/$(id -u)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/PlusExtractorRelay"
STDOUT_LOG="$LOG_DIR/relay.log"
STDERR_LOG="$LOG_DIR/relay-error.log"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js runtime was not found" >&2
  exit 1
fi

NODE_VERSION=$("$NODE_BIN" --version)
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if (( NODE_MAJOR < 18 )); then
  echo "Node.js 18 or newer is required; current major version: $NODE_MAJOR" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

mkdir -p "$PLIST_DIR" "$LOG_DIR"
NODE_XML="$(xml_escape "$NODE_BIN")"
RELAY_XML="$(xml_escape "$RELAY_SCRIPT")"
WORKDIR_XML="$(xml_escape "$SCRIPT_DIR")"
STDOUT_XML="$(xml_escape "$STDOUT_LOG")"
STDERR_XML="$(xml_escape "$STDERR_LOG")"

{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0">' '<dict>'
  printf '%s\n' '  <key>Label</key>' "  <string>$LABEL</string>"
  printf '%s\n' '  <key>ProgramArguments</key>' '  <array>'
  printf '%s\n' "    <string>$NODE_XML</string>" "    <string>$RELAY_XML</string>"
  printf '%s\n' '  </array>' '  <key>WorkingDirectory</key>' "  <string>$WORKDIR_XML</string>"
  printf '%s\n' '  <key>RunAtLoad</key>' '  <true/>'
  printf '%s\n' '  <key>KeepAlive</key>' '  <true/>'
  printf '%s\n' '  <key>StandardOutPath</key>' "  <string>$STDOUT_XML</string>"
  printf '%s\n' '  <key>StandardErrorPath</key>' "  <string>$STDERR_XML</string>"
  printf '%s\n' '</dict>' '</plist>'
} > "$PLIST"

launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 http://127.0.0.1:17898/status 2>/dev/null | grep -q '"ready":true'; then
    echo "RELAY_STARTED"
    echo "PROXY=127.0.0.1:17897"
    echo "CONTROL=127.0.0.1:17898"
    echo "AUTOSTART=$PLIST"
    exit 0
  fi
  sleep 0.125
done

echo "Relay process did not become ready; inspect $STDERR_LOG" >&2
exit 1
