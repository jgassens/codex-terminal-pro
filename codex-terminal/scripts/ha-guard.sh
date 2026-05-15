#!/usr/bin/env bash

set -euo pipefail

BROKER="/data/packages/guard/bin/supervisor-broker"
REAL_HA="/usr/libexec/codex-terminal/ha-real"
TOKEN_FILE="/data/.supervisor/token"

if [ ! -x "$REAL_HA" ]; then
    echo "Codex Terminal Pro: real Home Assistant CLI not found at $REAL_HA" >&2
    exit 127
fi

if [ -x "$BROKER" ]; then
    "$BROKER" ha "$@"
fi

if [ -f "$TOKEN_FILE" ]; then
    export SUPERVISOR_TOKEN
    SUPERVISOR_TOKEN="$(cat "$TOKEN_FILE")"
fi

exec "$REAL_HA" "$@"
