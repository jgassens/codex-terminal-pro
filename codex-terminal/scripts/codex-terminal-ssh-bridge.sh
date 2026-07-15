#!/usr/bin/env bash

set -euo pipefail

bridge_root="${CODEX_TERMINAL_SSH_BRIDGE_DIR:-/config/.codex-terminal-pro/ssh-bridge}"
request_root="${bridge_root}/requests"
log_file="${CODEX_TERMINAL_SSH_BRIDGE_LOG:-/data/logs/ssh-bridge.log}"
tmux_config="${CODEX_TERMINAL_TMUX_CONFIG:-/data/.tmux.conf}"
tmux_session="${TMUX_SESSION:-codex-terminal}"
tmux_target="${CODEX_TMUX_TARGET:-${TMUX_TARGET:-codex-terminal:0.0}}"
lock_dir="/tmp/codex-terminal-ssh-bridge.lock"
request_done_ttl="${CODEX_TERMINAL_SSH_DONE_TTL:-300}"
request_abandoned_ttl="${CODEX_TERMINAL_SSH_ABANDONED_TTL:-3600}"
mailbox_helper="${CODEX_TERMINAL_SSH_MAILBOX_HELPER:-/opt/scripts/codex-terminal-ssh-mailbox.py}"

log() {
    local message="$1"
    mkdir -p "$(dirname "$log_file")"
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$message" >> "$log_file"
    printf '%s\n' "$message"
}

cleanup_stale_requests() {
    python3 "$mailbox_helper" cleanup \
        "$request_root" "$(date +%s)" "$request_done_ttl" "$request_abandoned_ttl"
}

command_status() {
    printf 'Bridge: running\n'
    printf 'Bridge dir: %s\n' "$bridge_root"
    printf 'tmux target: %s\n' "$tmux_target"
    if tmux -f "$tmux_config" has-session -t "$tmux_session" 2>/dev/null; then
        printf 'tmux: %s session is running\n' "$tmux_session"
    else
        printf 'tmux: %s session is not running\n' "$tmux_session"
    fi
    printf 'Codex home: %s\n' "${CODEX_HOME:-/data/.codex}"
    printf 'Config dir: /config\n'
}

process_request() {
    local request_dir="$1"
    local work_dir command_file response_file stderr_file
    local command_name
    local exit_code=0
    local snapshot_exit=0

    umask 077
    work_dir="$(mktemp -d /tmp/codex-terminal-ssh-request.XXXXXX)"
    command_file="${work_dir}/command"
    response_file="${work_dir}/response"
    stderr_file="${work_dir}/stderr"

    if python3 "$mailbox_helper" snapshot "$request_root" "$request_dir" "$work_dir"; then
        snapshot_exit=0
    else
        snapshot_exit=$?
    fi
    if [ "$snapshot_exit" -eq 3 ]; then
        rm -rf "$work_dir"
        return 0
    fi
    if [ "$snapshot_exit" -ne 0 ]; then
        : > "$response_file"
        printf 'Unsafe SSH mailbox request rejected.\n' > "$stderr_file"
        python3 "$mailbox_helper" publish \
            "$request_root" "$request_dir" "$response_file" "$stderr_file" 2 || true
        rm -rf "$work_dir"
        return 0
    fi

    command_name="$(cat "$command_file")"
    : > "$response_file"
    : > "$stderr_file"

    set +e
    case "$command_name" in
        status)
            command_status > "$response_file" 2> "$stderr_file"
            exit_code=$?
            ;;
        *)
            printf 'The shared /config mailbox permits status only; this command requires Docker attach access.\n' > "$stderr_file"
            exit_code=2
            ;;
    esac
    set -e

    if python3 "$mailbox_helper" publish \
        "$request_root" "$request_dir" "$response_file" "$stderr_file" "$exit_code"; then
        rm -rf "$work_dir"
        return 0
    fi
    rm -rf "$work_dir"
    return 1
}

main() {
    if ! mkdir "$lock_dir" 2>/dev/null; then
        log "SSH bridge already running"
        exit 0
    fi
    trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

    mkdir -p "$request_root" "$(dirname "$log_file")"
    chmod 700 "$bridge_root" "$request_root" 2>/dev/null || true
    chmod 700 "$(dirname "$log_file")" 2>/dev/null || true

    log "SSH bridge listening in ${request_root}"

    case "$request_done_ttl" in
        ''|*[!0-9]*) request_done_ttl=300 ;;
    esac
    case "$request_abandoned_ttl" in
        ''|*[!0-9]*) request_abandoned_ttl=3600 ;;
    esac

    local last_cleanup=0 now
    while true; do
        now="$(date +%s)"
        if [ $((now - last_cleanup)) -ge 60 ]; then
            if ! cleanup_stale_requests; then
                log "SSH bridge cleanup failed safely; will retry"
            fi
            last_cleanup="$now"
        fi
        for request_dir in "$request_root"/*; do
            [ ! -L "$request_dir" ] || continue
            [ -d "$request_dir" ] || continue
            process_request "$request_dir" || log "Failed to process bridge request: ${request_dir}"
        done
        sleep 1
    done
}

if [[ "${CODEX_TERMINAL_SSH_BRIDGE_LIBRARY_ONLY:-false}" != "true" ]]; then
    main "$@"
fi
