#!/usr/bin/env bash
# Stop and remove the relay's Mac helper. Leaves Messages and imsg alone.
#   bash mac/uninstall.sh            # keeps the token in the Keychain
#   bash mac/uninstall.sh --forget   # also deletes the token from the Keychain
set -euo pipefail
LABEL="org.smsrelay.device"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/sms-relay-device"
if [ "${1:-}" = "--forget" ]; then
  security delete-generic-password -s "sms-relay-device-token" >/dev/null 2>&1 || true
  echo "Token removed from the Keychain."
fi
echo "Helper stopped and removed. Rotate DEVICE_TOKEN on the Worker if this Mac is being retired."
