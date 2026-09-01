#!/usr/bin/env bash

set -euo pipefail

CONF_FILE="/data/.supervisor/broker.conf"
CONFIRM_DIR="/data/.supervisor/confirm"
AUDIT_LOG="/data/logs/supervisor-broker.log"

SUPERVISOR_BROKER_ENABLED="true"
SUPERVISOR_BROKER_T1_TTL_SECONDS="120"
SUPERVISOR_BROKER_PRIMARY_TMUX_TARGET=""
SUPERVISOR_BROKER_RAW_TMUX_TARGET=""
SUPERVISOR_PATH_UTILS="${SUPERVISOR_PATH_UTILS:-/opt/scripts/supervisor-path-utils.sh}"

if [ ! -r "$SUPERVISOR_PATH_UTILS" ]; then
    echo "Codex Terminal Pro: Supervisor path validator is unavailable" >&2
    exit 1
fi
# shellcheck disable=SC1090
. "$SUPERVISOR_PATH_UTILS"

trim_config_value() {
    local value="$1"
    value="${value#${value%%[![:space:]]*}}"
    value="${value%${value##*[![:space:]]}}"
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s\n' "$value"
}

load_broker_config() {
    local line
    local key
    local value

    [ -f "$CONF_FILE" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*) continue ;;
            *=*) ;;
            *) echo "Codex Terminal Pro: invalid broker configuration line" >&2; return 1 ;;
        esac
        key="${line%%=*}"
        key="${key//[[:space:]]/}"
        value="$(trim_config_value "${line#*=}")"
        case "$key" in
            SUPERVISOR_BROKER_ENABLED)
                case "$value" in true|false) SUPERVISOR_BROKER_ENABLED="$value" ;; *) return 1 ;; esac
                ;;
            SUPERVISOR_BROKER_T1_TTL_SECONDS)
                case "$value" in ''|*[!0-9]*) return 1 ;; *) SUPERVISOR_BROKER_T1_TTL_SECONDS="$value" ;; esac
                ;;
            SUPERVISOR_BROKER_PRIMARY_TMUX_TARGET)
                case "$value" in *[!A-Za-z0-9_.:-]*|'') return 1 ;; *) SUPERVISOR_BROKER_PRIMARY_TMUX_TARGET="$value" ;; esac
                ;;
            SUPERVISOR_BROKER_RAW_TMUX_TARGET)
                case "$value" in *[!A-Za-z0-9_.:-]*|'') return 1 ;; *) SUPERVISOR_BROKER_RAW_TMUX_TARGET="$value" ;; esac
                ;;
            *) : ;; # Ignore retired keys without executing them as shell code.
        esac
    done < "$CONF_FILE"
}

if ! load_broker_config; then
    echo "Codex Terminal Pro: refusing invalid broker configuration" >&2
    exit 1
fi

mkdir -p "$CONFIRM_DIR" "$(dirname "$AUDIT_LOG")"
chmod 700 "$CONFIRM_DIR" "$(dirname "$AUDIT_LOG")" 2>/dev/null || true
touch "$AUDIT_LOG"
chmod 600 "$AUDIT_LOG" 2>/dev/null || true

audit() {
    local op="$1"
    local tier="$2"
    local decision="$3"
    local reason="${4:-}"
    printf '%s tier=%s decision=%s op=%q reason=%q\n' \
        "$(date -Iseconds)" "$tier" "$decision" "$op" "$reason" >> "$AUDIT_LOG"
}

sha_key() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
}

is_interactive() {
    [ -t 0 ] && [ -t 1 ]
}

is_same_process_session() {
    local pane_pid="${1:-}"

    case "$pane_pid" in
        ""|*[!0-9]*) return 1 ;;
    esac

    /usr/bin/python3 - "$pane_pid" <<'PY'
import os
import sys

try:
    pane_pid = int(sys.argv[1])
    same_session = pane_pid > 0 and os.getsid(0) == os.getsid(pane_pid)
except (OSError, ValueError):
    same_session = False

raise SystemExit(0 if same_session else 1)
PY
}

is_trusted_human_terminal() {
    local pane_identity
    local pane_id
    local pane_pid
    local target

    [ "${CODEX_TERMINAL_HUMAN_SHELL:-}" = "1" ] || return 1
    [ -n "${TMUX_PANE:-}" ] || return 1
    command -v tmux >/dev/null 2>&1 || return 1

    for target in \
        "$SUPERVISOR_BROKER_PRIMARY_TMUX_TARGET" \
        "$SUPERVISOR_BROKER_RAW_TMUX_TARGET"; do
        pane_identity="$(
            tmux display-message -p -t "$target" '#{pane_id}|#{pane_pid}' 2>/dev/null
        )" || continue
        IFS='|' read -r pane_id pane_pid <<< "$pane_identity"
        if [ "$pane_id" = "$TMUX_PANE" ] && is_same_process_session "$pane_pid"; then
            return 0
        fi
    done

    return 1
}

is_codex_managed_execution() {
    # Interactive Codex launches carry this marker so the wrapper knows that
    # Codex's own policy is the approval owner. This is a provenance guardrail,
    # not a containment boundary; the add-on's Codex process runs as root.
    [ "${CODEX_TERMINAL_AGENT_EXECUTION:-}" = "1" ]
}

strip_global_flags() {
    local -n out_ref=$1
    shift
    out_ref=()

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --api-token|--config|--endpoint|--log-level)
                shift 2 || break
                ;;
            --api-token=*|--config=*|--endpoint=*|--log-level=*)
                shift
                ;;
            --no-progress|--raw-json)
                shift
                ;;
            --help|-h|--version|version)
                out_ref+=("$1")
                shift
                ;;
            --*)
                shift
                ;;
            *)
                out_ref+=("$1")
                shift
                ;;
        esac
    done
}

classify_ha() {
    local args=("$@")
    local parsed=()
    local noun=""
    local verb=""
    local action=""

    strip_global_flags parsed "${args[@]}"

    noun="${parsed[0]:-}"
    verb="${parsed[1]:-}"
    action="${parsed[2]:-}"

    case "$noun" in
        app|ad|addon|add-on|addons|add-ons) noun="apps" ;;
        backup|back|bk|snapshots|snapshot|snap|shot|sn) noun="backups" ;;
        hassos) noun="os" ;;
        ho) noun="host" ;;
        super|su) noun="supervisor" ;;
        shop|stor) noun="store" ;;
    esac

    case "$noun" in
        apps)
            case "$verb" in
                i|inst) verb="install" ;;
                remove|delete|del|rem|un|uninst) verb="uninstall" ;;
            esac
            ;;
        backups)
            case "$verb" in
                delete|del|rem|rm) verb="remove" ;;
            esac
            ;;
        os)
            case "$verb" in
                boot) verb="boot-slot" ;;
                data) verb="datadisk" ;;
                upgrade|downgrade|up|down) verb="update" ;;
            esac
            ;;
        host)
            case "$verb" in
                restart|rb) verb="reboot" ;;
                sh) verb="shutdown" ;;
                update) verb="reload" ;;
            esac
            ;;
        supervisor)
            case "$verb" in
                upgrade|up) verb="update" ;;
            esac
            ;;
    esac

    case "$verb" in
        in|inf) verb="info" ;;
        log|lg) verb="logs" ;;
        status|stat|st) verb="stats" ;;
        validate|chk|ch) verb="check" ;;
    esac

    case "$noun" in
        ""|--help|-h|--version|version|help|info|in|inf|available-updates)
            echo "T0"
            return
            ;;
    esac

    case "$verb" in
        info|list|logs|stats|check|--help|-h|help)
            echo "T0"
            return
            ;;
    esac

    if [ "$noun" = "core" ] && [ "$verb" = "api" ]; then
        classify_rest_from_ha "${parsed[@]:2}"
        return
    fi

    case "${noun}:${verb}" in
        core:restart|core:reload|core:stop|core:start|core:update|core:rebuild|apps:restart|apps:stop|apps:start|apps:update|apps:rebuild|apps:options|addons:restart|addons:stop|addons:start|addons:update|addons:rebuild|addons:options|supervisor:reload|supervisor:repair|network:update|dns:update|audio:update|cli:update)
            echo "T1"
            return
            ;;
        host:reboot|host:shutdown|os:update|os:datadisk|os:boot-slot|supervisor:update|apps:install|apps:uninstall|backups:restore|backups:remove|backups:delete)
            echo "T2"
            return
            ;;
    esac

    if [ "$noun" = "store" ]; then
        case "$verb" in
            app|apps|ad|addon|add-on|addons|add-ons)
                case "$action" in
                    i|inst) action="install" ;;
                    remove|delete|del|rem|un|uninst) action="uninstall" ;;
                esac
                case "$action" in
                    install|uninstall|remove|delete)
                        echo "T2"
                        return
                        ;;
                esac
                ;;
        esac
    fi

    echo "T1"
}

classify_rest_from_ha() {
    local method="GET"
    local path=""

    while [ "$#" -gt 0 ]; do
        case "$1" in
            -X|--method)
                method="${2:-GET}"
                shift 2 || break
                ;;
            -X*)
                method="${1#-X}"
                shift
                ;;
            http://supervisor/*|/api/*|/core/*|/supervisor/*|/host/*|/os/*|/backups/*|/addons/*|/store/*)
                path="$1"
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    classify_rest "$method" "$path"
}

classify_rest() {
    local method="${1:-GET}"
    local path

    method="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
    if ! path="$(normalize_supervisor_path "${2:-}")"; then
        # Fail closed. Invalid or ambiguously normalized routes must never use
        # a cached T1 authorization for a different endpoint.
        echo "T2"
        return
    fi

    if [ "$method" = "GET" ]; then
        echo "T0"
        return
    fi

    if [ "$method" = "DELETE" ]; then
        echo "T2"
        return
    fi

    case "$path" in
        /host/reboot|/host/shutdown|/os/*|/backups/*/restore|/addons/*/uninstall|/store/addons/*/install|/supervisor/update)
            echo "T2"
            return
            ;;
    esac

    echo "T1"
}

explain_tier() {
    local tier="$1"
    local op="$2"

    case "$tier" in
        T1)
            cat <<EOF
Codex Terminal Pro is about to run a Home Assistant management operation:
  ${op}
This may reload, restart, update, or reconfigure Home Assistant or an add-on.
EOF
            ;;
        T2)
            cat <<EOF
Codex Terminal Pro is about to run a high-risk Home Assistant operation:
  ${op}
This can reboot or shut down the host, change OS/data-disk state, restore or
delete backups, or install/remove add-ons. Review this before continuing.
EOF
            ;;
    esac
}

check_t1_ttl() {
    local op_class="$1"
    local now
    local expiry_file
    local expiry

    now="$(date +%s)"
    expiry_file="$CONFIRM_DIR/$(sha_key "$op_class")"

    if [ -f "$expiry_file" ]; then
        expiry="$(cat "$expiry_file" 2>/dev/null || echo 0)"
        if [ "$expiry" -gt "$now" ] 2>/dev/null; then
            return 0
        fi
    fi

    return 1
}

write_t1_ttl() {
    local op_class="$1"
    local ttl="${SUPERVISOR_BROKER_T1_TTL_SECONDS:-120}"
    local now
    local expiry_file

    now="$(date +%s)"
    expiry_file="$CONFIRM_DIR/$(sha_key "$op_class")"
    printf '%s\n' "$((now + ttl))" > "$expiry_file"
    chmod 600 "$expiry_file"
}

authorize_t1() {
    local op="$1"
    local phrase="$2"
    local op_class="$3"
    local answer=""

    if ! is_interactive; then
        echo "Refusing non-interactive Home Assistant management operation: $op" >&2
        echo "Ask the human to re-run it interactively if this is intended." >&2
        audit "$op" "T1" "deny" "non-interactive"
        return 1
    fi

    if check_t1_ttl "$op_class"; then
        audit "$op" "T1" "allow" "ttl"
        return 0
    fi

    explain_tier "T1" "$op" >&2
    printf 'Type exactly "%s" to continue: ' "$phrase" >&2
    IFS= read -r answer

    if [ "$answer" = "$phrase" ]; then
        write_t1_ttl "$op_class"
        audit "$op" "T1" "allow" "confirmed"
        return 0
    fi

    echo "Confirmation did not match; operation cancelled." >&2
    audit "$op" "T1" "deny" "wrong phrase"
    return 1
}

authorize_t2() {
    local op="$1"
    local nonce
    local phrase
    local answer=""
    local reason=""

    if ! is_interactive; then
        echo "Refusing non-interactive high-risk Home Assistant operation: $op" >&2
        echo "Ask the human to re-run it interactively if this is intended." >&2
        audit "$op" "T2" "deny" "non-interactive"
        return 1
    fi

    nonce="$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n' | tr '[:lower:]' '[:upper:]')"
    phrase="CONFIRM ${nonce}"

    explain_tier "T2" "$op" >&2
    printf 'Type exactly "%s" to continue: ' "$phrase" >&2
    IFS= read -r answer
    if [ "$answer" != "$phrase" ]; then
        echo "Confirmation did not match; operation cancelled." >&2
        audit "$op" "T2" "deny" "wrong nonce"
        return 1
    fi

    printf 'Reason: ' >&2
    IFS= read -r reason
    if [ -z "${reason// }" ]; then
        echo "A reason is required; operation cancelled." >&2
        audit "$op" "T2" "deny" "missing reason"
        return 1
    fi

    audit "$op" "T2" "allow" "$reason"
    return 0
}

authorize() {
    local source="$1"
    shift
    local tier
    local op
    local noun
    local verb
    local phrase

    if [ "${SUPERVISOR_BROKER_ENABLED}" != "true" ]; then
        return 0
    fi

    case "$source" in
        ha)
            tier="$(classify_ha "$@")"
            noun="${1:-operation}"
            verb="${2:-}"
            op="ha $*"
            phrase="confirm ${noun}${verb:+ ${verb}}"
            ;;
        rest)
            local rest_method
            rest_method="$(printf '%s' "${1:-GET}" | tr '[:lower:]' '[:upper:]')"
            tier="$(classify_rest "$rest_method" "${2:-/}")"
            op="supervisor-api ${rest_method} ${2:-/}"
            phrase="confirm supervisor api"
            ;;
        *)
            tier="T1"
            op="$source $*"
            phrase="confirm operation"
            ;;
    esac

    if [ "$tier" = "T0" ]; then
        return 0
    fi

    if is_codex_managed_execution; then
        audit "$op" "$tier" "allow" "codex-approval-policy"
        return 0
    fi

    if is_trusted_human_terminal; then
        audit "$op" "$tier" "allow" "human-terminal"
        return 0
    fi

    case "$tier" in
        T1)
            authorize_t1 "$op" "$phrase" "${source}:${tier}:${noun:-rest}:${verb:-api}"
            ;;
        T2)
            authorize_t2 "$op"
            ;;
        *)
            authorize_t1 "$op" "$phrase" "${source}:unknown"
            ;;
    esac
}

authorize "$@"
