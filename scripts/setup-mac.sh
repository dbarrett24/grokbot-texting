#!/usr/bin/env bash
# Texting relay setup for macOS (Linux works too, for testing). Your bot runs these steps on YOUR computer,
# one at a time; each prints RELAY_STATUS lines it can read. Nothing here needs sudo.
#   bash scripts/setup-mac.sh <step> [--dry-run] [options]
# Steps: node install-node fetch deps test login iphone-helper mac-permissions, and (via scripts/setup-lib.mjs) keys ask
#        show config gateway-check confirm-fingerprint claim deploy secrets google smoke resolve
#        test-send copy-token clear-clipboard status
# Secrets never appear on screen, in a log, or on a command line. They stay in .relay-local/ (gitignored).
set -euo pipefail

REPO_URL="${RELAY_REPO_URL:-https://github.com/OWNER/sms-relay-template.git}"   # set to the public repo when it is published
NODE_LINE="latest-v22.x"
NODE_MIN=20
NODE_HOME="$HOME/.sms-relay/node"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${RELAY_DIR:-}" ]; then DIR="$RELAY_DIR"
elif [ -f "$HERE/../package.json" ] && grep -q '"sms-relay-template"' "$HERE/../package.json"; then DIR="$(cd "$HERE/.." && pwd)"
else DIR="$HOME/texting-relay"; fi
[ -x "$NODE_HOME/bin/node" ] && PATH="$NODE_HOME/bin:$PATH"
export PATH

STEP="${1:-help}"; shift || true
DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

status() { # step result [key=value ...]
  local s="$1" r="$2"; shift 2
  printf 'RELAY_STATUS step=%s result=%s' "$s" "$r"
  [ $# -gt 0 ] && printf ' %s' "$@"
  printf '\n'
}
logfile() { mkdir -p "$DIR/.relay-local/logs"; printf '%s' "$DIR/.relay-local/logs/$1.log"; }
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

step_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MIN" ]; then
    status node ok "version=$(node -v)" "npm=$(npm -v 2>/dev/null || echo none)"
  elif command -v node >/dev/null 2>&1; then
    status node fail reason=too_old "version=$(node -v)" next=install-node
  else
    status node fail reason=missing next=install-node
  fi
}

step_install_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MIN" ]; then status install-node skip "version=$(node -v)"; return; fi
  local os arch base file tmp
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) status install-node fail reason=unsupported_os; return 1 ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) status install-node fail reason=unsupported_cpu; return 1 ;; esac
  base="https://nodejs.org/dist/$NODE_LINE"
  if [ "$DRY" = 1 ]; then status install-node dry_run "would_get=$base/node-*-$os-$arch.tar.gz" "into=$NODE_HOME"; return; fi
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || { status install-node fail reason=download_failed; return 1; }
  file="$(awk -v s="-$os-$arch.tar.gz" '$2 ~ s"$" {print $2; exit}' "$tmp/SHASUMS256.txt")"
  [ -n "$file" ] || { status install-node fail reason=no_build_found; return 1; }
  curl -fsSL "$base/$file" -o "$tmp/$file" || { status install-node fail reason=download_failed; return 1; }
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | { shasum -a 256 -c - 2>/dev/null || sha256sum -c -; } >/dev/null) \
    || { status install-node fail reason=checksum_mismatch; return 1; }
  rm -rf "$NODE_HOME" && mkdir -p "$NODE_HOME"
  tar -xzf "$tmp/$file" -C "$NODE_HOME" --strip-components 1
  rm -rf "$tmp"
  PATH="$NODE_HOME/bin:$PATH"
  status install-node ok "version=$(node -v)" "where=$NODE_HOME"
}

have_git() {
  command -v git >/dev/null 2>&1 || return 1
  [ "$(uname -s)" != "Darwin" ] || xcode-select -p >/dev/null 2>&1   # on a Mac without developer tools, git is only a stub
}

step_fetch() {
  case "$REPO_URL" in *github.com/OWNER/*) status fetch fail reason=repo_url_not_set; return 1 ;; esac
  if [ "$DRY" = 1 ] && [ ! -d "$DIR/.git" ]; then status fetch dry_run "would_clone_into=$DIR"; fi
  if have_git; then
    if [ -d "$DIR/.git" ]; then
      git -C "$DIR" pull --ff-only -q >"$(logfile fetch)" 2>&1 || { status fetch fail reason=update_failed log=.relay-local/logs/fetch.log; return 1; }
      status fetch ok how=git_update "commit=$(git -C "$DIR" rev-parse --short HEAD)" "dir=$DIR"
    else
      [ "$DRY" = 1 ] && return 0
      git clone -q "$REPO_URL" "$DIR" 2>/dev/null || { status fetch fail reason=clone_failed; return 1; }
      status fetch ok how=git_clone "commit=$(git -C "$DIR" rev-parse --short HEAD)" "dir=$DIR"
    fi
  else
    [ "$DRY" = 1 ] && return 0
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL "${REPO_URL%.git}/archive/refs/heads/main.tar.gz" -o "$tmp/src.tgz" || { status fetch fail reason=download_failed; return 1; }
    mkdir -p "$DIR" && tar -xzf "$tmp/src.tgz" -C "$DIR" --strip-components 1   # keeps .relay-local/ as it is
    rm -rf "$tmp"
    status fetch ok how=download "dir=$DIR"
  fi
}

need_repo() { [ -f "$DIR/package.json" ] || { status "$STEP" fail reason=run_fetch_first; exit 1; }; }

step_deps() {
  need_repo
  if [ "$DRY" = 1 ]; then status deps dry_run would_run=npm_ci; return; fi
  if (cd "$DIR" && npm ci --legacy-peer-deps --no-audit --no-fund) >"$(logfile deps)" 2>&1; then status deps ok
  else status deps fail log=.relay-local/logs/deps.log; return 1; fi
}

step_test() {
  need_repo
  local lf; lf="$(logfile test)"
  if (cd "$DIR" && npm test && npm run typecheck) >"$lf" 2>&1; then
    status test ok "passed=$(grep -Eo 'Tests +[0-9]+ passed' "$lf" | awk '{n+=$2} END {print n+0}')" typecheck=clean
  else
    status test fail log=.relay-local/logs/test.log next=stop_do_not_deploy; return 1
  fi
}

step_login() {
  need_repo
  if [ "$DRY" = 1 ]; then status login dry_run would_open=cloudflare_sign_in_in_your_browser; return; fi
  (cd "$DIR" && npx wrangler whoami) >"$(logfile login)" 2>&1 || true
  if grep -qiE 'not authenticated|not logged in' "$(logfile login)"; then
    (cd "$DIR" && npx wrangler login) >>"$(logfile login)" 2>&1 || { status login needs_human reason=browser_sign_in_not_finished; return 2; }
  fi
  local lf; lf="$(logfile login-check)"
  if (cd "$DIR" && npx wrangler whoami) >"$lf" 2>&1 && ! grep -qiE 'not authenticated|not logged in' "$lf"; then status login ok
  else status login needs_human reason=sign_in_failed; return 2; fi
}

step_iphone_helper() {
  need_repo
  [ "$(uname -s)" = "Darwin" ] || { status iphone-helper fail reason=needs_a_mac; return 1; }
  if ! command -v imsg >/dev/null 2>&1; then
    if ! command -v brew >/dev/null 2>&1; then status iphone-helper needs_human reason=install_homebrew url=https://brew.sh; return 2; fi
    [ "$DRY" = 1 ] && { status iphone-helper dry_run would_run=brew_install_imsg; return; }
    brew install steipete/tap/imsg >"$(logfile iphone-helper)" 2>&1 || { status iphone-helper fail reason=imsg_install_failed log=.relay-local/logs/iphone-helper.log; return 1; }
  fi
  local url tok
  url="https://$(node -p 'require(process.argv[1]).apiHost' "$DIR/.relay-local/settings.json" 2>/dev/null)"
  [ "$url" != "https://" ] && [ "$url" != "https://undefined" ] || { status iphone-helper fail reason=run_config_first; return 1; }
  [ "$DRY" = 1 ] && { status iphone-helper dry_run "relay=$url" would_store=device_token_in_keychain; return; }
  tok="$(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8").match(/^DEVICE_TOKEN=(".*")$/m); if(!t) process.exit(1); process.stdout.write(JSON.parse(t[1]))' "$DIR/.relay-local/secrets.env")" \
    || { status iphone-helper fail reason=run_keys_first; return 1; }
  # Into the login Keychain through security's stdin, so the token is never on a command line.
  printf 'add-generic-password -U -a "%s" -s "sms-relay-device-token" -l "SMS relay device token" -w "%s"\n' "$USER" "$tok" | security -i >/dev/null 2>&1 \
    || { tok=""; status iphone-helper fail reason=keychain_refused; return 1; }
  tok=""
  if RELAY_URL="$url" DEVICE_TOKEN_PRESET=1 bash "$DIR/mac/install.sh" >"$(logfile iphone-helper)" 2>&1; then
    status iphone-helper ok next=allow_automation_and_full_disk_access "node_path=$(command -v node)"
  else status iphone-helper fail log=.relay-local/logs/iphone-helper.log; return 1; fi
}

step_mac_permissions() {
  # Opens the Full Disk Access list and shows node in Finder, so the owner can drag it in.
  [ "$(uname -s)" = "Darwin" ] || { status mac-permissions fail reason=needs_a_mac; return 1; }
  [ "$DRY" = 1 ] && { status mac-permissions dry_run would_open=full_disk_access_and_node_in_finder; return; }
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" && open -R "$(command -v node)" \
    && status mac-permissions needs_human next=drag_node_into_full_disk_access
}

case "$STEP" in
  node) step_node ;;
  install-node) step_install_node ;;
  fetch) step_fetch ;;
  deps) step_deps ;;
  test) step_test ;;
  login) step_login ;;
  iphone-helper) step_iphone_helper ;;
  mac-permissions) step_mac_permissions ;;
  keys|ask|show|config|gateway-check|confirm-fingerprint|claim|deploy|secrets|google|smoke|resolve|test-send|copy-token|clear-clipboard|status)
    need_repo
    command -v node >/dev/null 2>&1 || { status "$STEP" fail reason=no_node next=install-node; exit 1; }
    exec node "$DIR/scripts/setup-lib.mjs" "$STEP" "$@" ;;
  help|-h|--help) sed -n '2,8p' "$0" ;;
  *) status usage fail "unknown_step=$STEP"; exit 3 ;;
esac
