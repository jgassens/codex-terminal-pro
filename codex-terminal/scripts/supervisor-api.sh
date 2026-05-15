#!/usr/bin/env bash

set -euo pipefail

BROKER="/data/packages/guard/bin/supervisor-broker"
TOKEN_FILE="/data/.supervisor/token"
METHOD="GET"

usage() {
    cat <<EOF
Usage: supervisor-api [-X METHOD] /path [curl-args...]

Examples:
  supervisor-api /core/info
  supervisor-api -X POST /core/restart
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -X|--request)
            METHOD="${2:-}"
            shift 2 || true
            ;;
        -X*)
            METHOD="${1#-X}"
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

PATH_PART="${1:-}"
if [ -z "$PATH_PART" ]; then
    usage >&2
    exit 2
fi
shift

if [ -x "$BROKER" ]; then
    "$BROKER" rest "$METHOD" "$PATH_PART"
fi

if [ ! -f "$TOKEN_FILE" ]; then
    echo "Codex Terminal Pro: supervisor token file is missing" >&2
    exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
URL="http://supervisor/${PATH_PART#/}"

exec curl -fsSL \
    -X "$METHOD" \
    -H "Authorization: Bearer ${TOKEN}" \
    "$@" \
    "$URL"
