#!/usr/bin/env bash

set -euo pipefail

BROKER="/data/packages/guard/bin/supervisor-broker"
TOKEN_FILE="/data/.supervisor/token"
CURL_BIN="/usr/bin/curl"
METHOD="GET"
CONNECT_TIMEOUT="10"
MAX_TIME="60"
MAX_CONNECT_TIMEOUT="60"
MAX_REQUEST_TIME="300"
SUPERVISOR_PATH_UTILS="${SUPERVISOR_PATH_UTILS:-/opt/scripts/supervisor-path-utils.sh}"

if [ ! -r "$SUPERVISOR_PATH_UTILS" ]; then
    echo "Codex Terminal Pro: Supervisor path validator is unavailable" >&2
    exit 1
fi
# shellcheck disable=SC1090
. "$SUPERVISOR_PATH_UTILS"

usage() {
    cat <<EOF
Usage: supervisor-api [-X METHOD] /path [safe-request-options...]

Examples:
  supervisor-api /core/info
  supervisor-api -X POST /core/restart
  supervisor-api -X POST /core/api/services/automation/reload \
    -H 'Content-Type: application/json' -d '{}'

Allowed request options:
  -H, --header              Accept or Content-Type headers only
  -d, --data                Inline request body
      --data-raw            Inline request body
      --data-binary         Inline request body
      --connect-timeout     Connection timeout, >0 and <=60 seconds (default: 10)
      --max-time            Overall timeout, >0 and <=300 seconds (default: 60)
EOF
}

die_usage() {
    echo "supervisor-api: $*" >&2
    exit 2
}

require_option_value() {
    local option="$1"
    local value="${2-}"

    if [ -z "$value" ]; then
        die_usage "$option requires a value"
    fi
}

append_header() {
    local header="$1"
    local name

    case "$header" in
        @*) die_usage "header files are not supported" ;;
    esac
    case "$header" in
        *$'\r'*|*$'\n'*) die_usage "header values cannot contain newlines" ;;
    esac
    case "$header" in
        *:*) ;;
        *) die_usage "headers must use NAME: VALUE syntax" ;;
    esac

    name="$(printf '%s' "${header%%:*}" | tr '[:upper:]' '[:lower:]')"
    case "$name" in
        accept|content-type) ;;
        *) die_usage "header '$name' is not allowed" ;;
    esac

    CURL_ARGS+=(--header "$header")
}

append_data() {
    local option="$1"
    local value="$2"

    # Curl interprets a leading @ as a file read for these options. Keep this
    # helper limited to explicit inline bodies so it cannot be used to copy a
    # container secret into an authenticated request by accident.
    case "$value" in
        @*) die_usage "$option accepts inline data only" ;;
    esac
    CURL_ARGS+=("$option" "$value")
}

append_timeout() {
    local option="$1"
    local value="$2"
    local maximum

    case "$value" in
        ''|*[!0-9.]*|.*|*..*|*.) die_usage "$option requires a positive number" ;;
    esac
    case "$option" in
        --connect-timeout) maximum="$MAX_CONNECT_TIMEOUT" ;;
        --max-time) maximum="$MAX_REQUEST_TIME" ;;
        *) die_usage "unsupported timeout option '$option'" ;;
    esac
    if ! awk -v value="$value" -v maximum="$maximum" \
        'BEGIN { exit !(value > 0 && value <= maximum) }'; then
        die_usage "$option must be greater than zero and no more than $maximum seconds"
    fi

    case "$option" in
        --connect-timeout) CONNECT_TIMEOUT="$value" ;;
        --max-time) MAX_TIME="$value" ;;
    esac
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -X|--request)
            require_option_value "$1" "${2-}"
            METHOD="$2"
            shift 2
            ;;
        -X*)
            METHOD="${1#-X}"
            shift
            ;;
        --request=*)
            METHOD="${1#*=}"
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            break
            ;;
    esac
done

METHOD="$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')"
case "$METHOD" in
    GET|POST|PUT|PATCH|DELETE) ;;
    *) die_usage "unsupported HTTP method '$METHOD'" ;;
esac

PATH_PART="${1:-}"
if [ -z "$PATH_PART" ]; then
    usage >&2
    exit 2
fi
shift

case "$PATH_PART" in
    /*) ;;
    *) die_usage "pass a Supervisor path beginning with /, not a URL" ;;
esac
case "$PATH_PART" in
    *$'\r'*|*$'\n'*) die_usage "path cannot contain newlines" ;;
esac
if ! normalize_supervisor_path "$PATH_PART" >/dev/null; then
    die_usage "path is ambiguous or contains an unsupported segment"
fi

CURL_ARGS=()
option=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -H|--header)
            require_option_value "$1" "${2-}"
            append_header "$2"
            shift 2
            ;;
        -H?*)
            append_header "${1#-H}"
            shift
            ;;
        --header=*)
            append_header "${1#*=}"
            shift
            ;;
        -d|--data|--data-raw|--data-binary)
            require_option_value "$1" "${2-}"
            option="$1"
            if [ "$option" = "-d" ]; then
                option="--data"
            fi
            append_data "$option" "$2"
            shift 2
            ;;
        -d?*)
            append_data --data "${1#-d}"
            shift
            ;;
        --data=*|--data-raw=*|--data-binary=*)
            option="${1%%=*}"
            append_data "$option" "${1#*=}"
            shift
            ;;
        --connect-timeout|--max-time)
            require_option_value "$1" "${2-}"
            append_timeout "$1" "$2"
            shift 2
            ;;
        --connect-timeout=*|--max-time=*)
            option="${1%%=*}"
            append_timeout "$option" "${1#*=}"
            shift
            ;;
        *)
            die_usage "request option '$1' is not allowed"
            ;;
    esac
done

if [ ! -x "$BROKER" ]; then
    echo "Codex Terminal Pro: Supervisor authorization broker is missing or not executable" >&2
    exit 1
fi
"$BROKER" rest "$METHOD" "$PATH_PART"

if [ ! -f "$TOKEN_FILE" ]; then
    echo "Codex Terminal Pro: supervisor token file is missing" >&2
    exit 1
fi

TOKEN="$(<"$TOKEN_FILE")"
URL="http://supervisor/${PATH_PART#/}"

# Curl reads this header from its standard-input config so the manager token is
# not exposed in /proc/<pid>/cmdline. Reject config metacharacters rather than
# allowing a malformed token file to inject another curl option.
case "$TOKEN" in
    ''|*$'\r'*|*$'\n'*|*\"*|*\\*)
        echo "Codex Terminal Pro: supervisor token file is invalid" >&2
        exit 1
        ;;
esac

exec "$CURL_BIN" --disable \
    --fail \
    --silent \
    --show-error \
    --globoff \
    --noproxy '*' \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" \
    -X "$METHOD" \
    --config - \
    "${CURL_ARGS[@]}" \
    "$URL" <<CURL_CONFIG
header = "Authorization: Bearer ${TOKEN}"
CURL_CONFIG
