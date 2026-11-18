#!/bin/sh
set -eu

: "${HOME:=/data/opencode/home}"
: "${XDG_CONFIG_HOME:=/config}"
: "${XDG_DATA_HOME:=/data/opencode/data}"
: "${XDG_CACHE_HOME:=/data/opencode/cache}"
: "${XDG_STATE_HOME:=/data/opencode/state}"
export HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME

mkdir -p "$HOME" "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" \
  "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "OPENCODE_SERVER_PASSWORD is required" >&2
  exit 1
fi

echo "Factory OpenCode runtime (isolated)"
echo "  config: $XDG_CONFIG_HOME/opencode"
echo "  data:   $XDG_DATA_HOME"
echo "  cache:  $XDG_CACHE_HOME"
echo "  state:  $XDG_STATE_HOME"

exec opencode serve \
  --hostname 0.0.0.0 \
  --port "${OPENCODE_PORT:-4096}"
