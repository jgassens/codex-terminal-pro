#!/usr/bin/env bash

set -euo pipefail

BROKER="/data/packages/guard/bin/supervisor-broker"
REAL_HA="/usr/libexec/codex-terminal/ha-real"
TOKEN_FILE="/data/.supervisor/token"

reject_cli_overrides() {
    local argument
    for argument in "$@"; do
        case "$argument" in
            --endpoint|--endpoint=*|--api-token|--api-token=*|--config|--config=*|--log-level|--log-level=*)
                echo "Codex Terminal Pro: $argument is managed by the guarded Home Assistant CLI and cannot be overridden" >&2
                return 2
                ;;
        esac
    done
}

if [ ! -x "$REAL_HA" ]; then
    echo "Codex Terminal Pro: real Home Assistant CLI not found at $REAL_HA" >&2
    exit 127
fi

reject_cli_overrides "$@" || exit $?

# Do not let caller-controlled Viper variables reach either the broker or the
# real CLI. The managed token is loaded only after authorization succeeds.
unset SUPERVISOR_TOKEN SUPERVISOR_ENDPOINT SUPERVISOR_CONFIG SUPERVISOR_LOG_LEVEL SUPERVISOR_API_TOKEN
unset 'SUPERVISOR_API-TOKEN' 2>/dev/null || true

if [ ! -f "$TOKEN_FILE" ] || [ -L "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
    echo "Codex Terminal Pro: managed Supervisor token is unavailable; refusing command" >&2
    exit 1
fi

if [ ! -x "$BROKER" ]; then
    echo "Codex Terminal Pro: Home Assistant authorization broker is missing; refusing command" >&2
    exit 1
fi
"$BROKER" ha "$@"

export SUPERVISOR_TOKEN
SUPERVISOR_TOKEN="$(cat "$TOKEN_FILE")"

# Viper also reads environment variables and $HOME/.homeassistant.yaml. Remove
# every caller-controlled override and force safe global flags after the broker
# authorizes the caller's actual subcommand. Keep the token in the environment
# so it never appears in process arguments or debug output (log level is fixed).
exec "$REAL_HA" --endpoint supervisor --config /dev/null --log-level warn "$@"
