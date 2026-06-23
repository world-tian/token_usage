#!/bin/sh
set -eu

SERVER=""
CODE=""
CODEX_ROOT=""
CLAUDE_ROOT=""
ANTIGRAVITY_ROOT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --code) CODE="${2:-}"; shift 2 ;;
    --codexRoot) CODEX_ROOT="${2:-}"; shift 2 ;;
    --claudeRoot) CLAUDE_ROOT="${2:-}"; shift 2 ;;
    --antigravityRoot) ANTIGRAVITY_ROOT="${2:-}"; shift 2 ;;
    *) echo "Token Tide: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVER" ] || [ -z "$CODE" ]; then
  echo "Token Tide: --server and --code are required" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Token Tide requires Node.js 22 or newer for this PoC installer." >&2
  echo "Download Node.js, then run the same command again." >&2
  exit 1
fi

HOME_DIR="${TOKEN_TIDE_HOME:-$HOME/.token-tide}"
BIN_DIR="$HOME_DIR/bin"
COLLECTOR="$BIN_DIR/token-tide.mjs"
ADAPTERS="$BIN_DIR/adapters.mjs"
mkdir -p "$BIN_DIR"

echo "Token Tide: installing the collector in $BIN_DIR"
t=$(date +%s)
curl -fsSL "$SERVER/install/collector.mjs?t=$t" -o "$COLLECTOR"
curl -fsSL "$SERVER/install/adapters.mjs?t=$t" -o "$ADAPTERS"
chmod 700 "$COLLECTOR"

ARGS="daemon --server \"$SERVER\" --code \"$CODE\""
if [ -n "$CODEX_ROOT" ]; then ARGS="$ARGS --codexRoot \"$CODEX_ROOT\""; fi
if [ -n "$CLAUDE_ROOT" ]; then ARGS="$ARGS --claudeRoot \"$CLAUDE_ROOT\""; fi
if [ -n "$ANTIGRAVITY_ROOT" ]; then ARGS="$ARGS --antigravityRoot \"$ANTIGRAVITY_ROOT\""; fi

eval "exec node \"$COLLECTOR\" $ARGS"
