#!/usr/bin/env bash

set -euo pipefail

bridge_root="${CODEX_TERMINAL_SSH_BRIDGE_DIR:-/config/.codex-terminal-pro/ssh-bridge}"
request_root="${bridge_root}/requests"
log_file="${CODEX_TERMINAL_SSH_BRIDGE_LOG:-/data/logs/ssh-bridge.log}"
tmux_config="${CODEX_TERMINAL_TMUX_CONFIG:-/data/.tmux.conf}"
tmux_session="${TMUX_SESSION:-codex-terminal}"
tmux_target="${CODEX_TMUX_TARGET:-${TMUX_TARGET:-codex-terminal:0.0}}"
lock_dir="${CODEX_TERMINAL_SSH_LOCK_DIR:-/tmp/codex-terminal-ssh-bridge.lock}"
request_done_ttl="${CODEX_TERMINAL_SSH_DONE_TTL:-300}"
request_abandoned_ttl="${CODEX_TERMINAL_SSH_ABANDONED_TTL:-3600}"
mailbox_helper="${CODEX_TERMINAL_SSH_MAILBOX_HELPER:-/opt/scripts/codex-terminal-ssh-mailbox.py}"

log() {
    local message="$1"
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$message" >> "$log_file"
    printf '%s\n' "$message"
}

prepare_bridge_directories() {
    python3 "$mailbox_helper" prepare \
        "$bridge_root" "$request_root" "$(dirname "$log_file")"
}

release_bridge_lock() {
    local recorded_pid=""
    local pid_file="${lock_dir}/pid"

    [ ! -L "$lock_dir" ] || return 0
    [ -d "$lock_dir" ] || return 0
    [ ! -L "$pid_file" ] || return 0
    [ -f "$pid_file" ] || return 0
    IFS= read -r recorded_pid < "$pid_file" || true
    [ "$recorded_pid" = "$$" ] || return 0

    rm -f -- "$pid_file"
    rmdir -- "$lock_dir" 2>/dev/null || true
}

acquire_bridge_lock() {
    local pid_file="${lock_dir}/pid"
    local existing_pid=""

    umask 077
    if mkdir -m 700 -- "$lock_dir" 2>/dev/null; then
        printf '%s\n' "$$" > "$pid_file"
        trap release_bridge_lock EXIT
        return 0
    fi

    # Refuse non-directory and symlink lock entries.  A stale lock created by
    # this script contains only a regular PID file; anything else is left
    # untouched for an operator to inspect.
    if [ -L "$lock_dir" ] || [ ! -d "$lock_dir" ] || [ ! -O "$lock_dir" ]; then
        return 2
    fi
    if [ -L "$pid_file" ] || { [ -e "$pid_file" ] && [ ! -f "$pid_file" ]; }; then
        return 2
    fi

    if [ -f "$pid_file" ]; then
        [ -O "$pid_file" ] || return 2
        IFS= read -r existing_pid < "$pid_file" || true
        if [[ "$existing_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
            return 1
        fi
        rm -f -- "$pid_file" || return 2
    fi

    # rmdir succeeds only for the exact, now-empty lock directory.  It cannot
    # recursively remove an entry planted alongside the stale PID file.
    rmdir -- "$lock_dir" 2>/dev/null || return 2
    if ! mkdir -m 700 -- "$lock_dir" 2>/dev/null; then
        # Another instance won the recovery race; leave its lock alone.
        return 1
    fi
    printf '%s\n' "$$" > "$pid_file"
    trap release_bridge_lock EXIT
    return 0
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
    local lock_status=0

    if ! prepare_bridge_directories; then
        printf 'SSH bridge directory setup failed safely.\n' >&2
        return 1
    fi

    acquire_bridge_lock || lock_status=$?
    case "$lock_status" in
        0)
            ;;
        1)
            log "SSH bridge already running"
            return 0
            ;;
        *)
            log "SSH bridge lock path is unsafe or cannot be recovered: ${lock_dir}"
            return 1
            ;;
    esac

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
