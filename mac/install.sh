#!/usr/bin/env bash
# Install the relay's Mac helper as a LaunchAgent for the logged-in user. Run it on the Mac that stays on,
# signed into Messages with the same Apple ID as the iPhone. It changes nothing system-wide: no sudo, SIP
# stays on, no inbound port. Undo with mac/uninstall.sh.
#   bash mac/install.sh            # asks for the relay URL and the device token
set -euo pipefail

LABEL="org.smsrelay.device"
SERVICE="sms-relay-device-token"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/sms-relay-device"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/sms-relay-device.log"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "run this on the Mac that will send the texts"
[ "$(id -u)" != "0" ] || die "run it as your own user, not with sudo (Messages needs your login session)"

if csrutil status 2>/dev/null | grep -qi "disabled"; then
  say "Note: System Integrity Protection is OFF on this Mac. This helper doesn't need that; it only uses"
  say "Apple's public Messages scripting. Turning SIP back on is recommended."
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js 18+ is needed: brew install node"
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node.js 18+ is needed: brew upgrade node"

IMSG="$(command -v imsg || true)"
[ -n "$IMSG" ] || die "imsg is needed: brew install steipete/tap/imsg"
VERSION="$("$IMSG" --version)"
"$NODE" --input-type=module -e "import { versionOk } from '$HERE/relay-device.mjs'; process.exit(versionOk(process.argv[1]) ? 0 : 1)" "$VERSION" \
  || die "imsg $VERSION is too old; 0.6.0+ is required (brew upgrade imsg)"

printf 'Relay URL (your REQUEST_HOST, like https://api.example.com): '
read -r RELAY_URL
"$NODE" --input-type=module -e "import { relayOrigin } from '$HERE/relay-device.mjs'; relayOrigin(process.argv[1])" "$RELAY_URL" \
  || die "that isn't an https:// host"

say ""
say "Paste the DEVICE_TOKEN you set with 'npx wrangler secret put DEVICE_TOKEN'."
say "It goes into your login Keychain only (macOS asks for it below; nothing is echoed or written to a file)."
security add-generic-password -U -a "$USER" -s "$SERVICE" -l "SMS relay device token" -w

mkdir -p "$DEST" "$(dirname "$PLIST")" "$(dirname "$LOG")"
cp "$HERE/relay-device.mjs" "$DEST/relay-device.mjs"
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed -e "s|__NODE__|$(esc "$NODE")|" -e "s|__HELPER__|$(esc "$DEST/relay-device.mjs")|" \
    -e "s|__RELAY_URL__|$(esc "$RELAY_URL")|" -e "s|__IMSG__|$(esc "$IMSG")|" -e "s|__LOG__|$(esc "$LOG")|g" \
    "$HERE/org.smsrelay.device.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "the generated LaunchAgent didn't validate"

RELAY_URL="$RELAY_URL" IMSG_PATH="$IMSG" "$NODE" "$DEST/relay-device.mjs" --check

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat <<STEPS

Installed. The helper is polling $RELAY_URL every 5 seconds. Log: $LOG

Three steps only you can do on this Mac:

1. Automation permission (required). The first time a text is sent, macOS asks
   "node wants access to control Messages". Click Allow. If you missed it or clicked Don't Allow:
   System Settings > Privacy & Security > Automation > node > turn on Messages.
   Until it's on, every send fails and the relay logs it (nothing is retried).

2. Full Disk Access for node (recommended). It lets imsg read the Messages database to confirm each
   text really went out, and catch the macOS 26 "sent but not delivered" bug. Without it, sends report
   "sent_unverified". System Settings > Privacy & Security > Full Disk Access > + > $NODE

3. Keep the Mac awake and logged in. System Settings > Energy (or Battery > Options):
   "Prevent automatic sleeping when the display is off". With FileVault on, after any restart nothing
   sends until you log in again; the relay warns you if the Mac goes quiet for 10 minutes.

For green-bubble SMS, also turn on Text Message Forwarding on the iPhone for this Mac
(Settings > Apps > Messages > Text Message Forwarding). The iPhone must be on and online for SMS.
STEPS
