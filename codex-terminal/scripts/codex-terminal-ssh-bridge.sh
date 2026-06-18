#!/usr/bin/env bash

set -euo pipefail

bridge_root="${CODEX_TERMINAL_SSH_BRIDGE_DIR:-/config/.codex-terminal-pro/ssh-bridge}"
request_root="${bridge_root}/requests"
log_file="${CODEX_TERMINAL_SSH_BRIDGE_LOG:-/data/logs/ssh-bridge.log}"
tmux_config="${CODEX_TERMINAL_TMUX_CONFIG:-/data/.tmux.conf}"
tmux_session="${TMUX_SESSION:-codex-terminal}"
tmux_target="${CODEX_TMUX_TARGET:-${TMUX_TARGET:-codex-terminal:0.0}}"
transcript_file="${CODEX_TERMINAL_TRANSCRIPT:-/data/logs/codex-terminal.log}"
lock_dir="/tmp/codex-terminal-ssh-bridge.lock"

log() {
    local message="$1"
    mkdir -p "$(dirname "$log_file")"
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$message" >> "$log_file"
    printf '%s\n' "$message"
}

validate_line_count() {
    local value="$1"

    case "$value" in
        ''|*[!0-9]*)
            printf 'Line count must be a positive integer, got: %s\n' "$value" >&2
            return 2
            ;;
        0)
            printf 'Line count must be greater than zero.\n' >&2
            return 2
            ;;
    esac
}

ensure_tmux_session() {
    if tmux -f "$tmux_config" has-session -t "$tmux_session" 2>/dev/null; then
        return 0
    fi

    printf 'Codex Terminal Pro tmux session is not running.\n' >&2
    return 1
}

send_file_to_codex() {
    local input_file="$1"
    local buffer_name="codex-terminal-ssh-bridge-$$-$(date +%s 2>/dev/null || printf now)"

    ensure_tmux_session
    tmux -f "$tmux_config" load-buffer -b "$buffer_name" "$input_file"
    tmux -f "$tmux_config" paste-buffer -p -d -b "$buffer_name" -t "$tmux_target"
    tmux -f "$tmux_config" send-keys -t "$tmux_target" Enter
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

command_capture() {
    local lines="$1"

    validate_line_count "$lines"
    ensure_tmux_session
    tmux -f "$tmux_config" capture-pane -p -J -t "$tmux_target" -S "-${lines}"
}

command_transcript() {
    local lines="$1"

    validate_line_count "$lines"
    if [ ! -f "$transcript_file" ]; then
        printf 'Transcript not found at %s.\n' "$transcript_file" >&2
        printf 'It may be disabled with terminal_transcript_enabled: false.\n' >&2
        return 1
    fi
    tail -n "$lines" "$transcript_file"
}

command_send() {
    local input_file="$1"

    if [ ! -s "$input_file" ]; then
        printf 'send request did not include prompt text.\n' >&2
        return 2
    fi
    send_file_to_codex "$input_file"
    printf 'Sent prompt to Codex Terminal Pro.\n'
}

command_ask_file() {
    local output_path="$1"
    local request_file="$2"
    local prompt_file

    case "$output_path" in
        /config/*)
            ;;
        *)
            printf 'ask-file output path must be under /config, got: %s\n' "$output_path" >&2
            return 2
            ;;
    esac

    if [ ! -s "$request_file" ]; then
        printf 'ask-file request did not include prompt text.\n' >&2
        return 2
    fi

    prompt_file="$(mktemp)"
    {
        printf 'Please answer this Codex Terminal Pro SSH-side request by writing your answer to `%s`.\n' "$output_path"
        printf 'Keep the file concise and do not read, print, or copy secrets. '
        printf 'After writing the file, say only that `%s` is ready.\n\n' "$output_path"
        printf 'Request:\n'
        cat "$request_file"
        printf '\n'
    } > "$prompt_file"

    set +e
    send_file_to_codex "$prompt_file"
    local exit_code=$?
    set -e
    if [ "$exit_code" -ne 0 ]; then
        rm -f "$prompt_file"
        return "$exit_code"
    fi
    rm -f "$prompt_file"
    printf 'Sent request to Codex. Read the answer from SSH with:\n'
    printf '  cat %s\n' "$output_path"
}

write_result() {
    local request_dir="$1"
    local exit_code="$2"

    printf '%s\n' "$exit_code" > "${request_dir}/exit_code"
    touch "${request_dir}/done"
}

process_request() {
    local request_dir="$1"
    local command_file="${request_dir}/command"
    local stdin_file="${request_dir}/stdin"
    local response_file="${request_dir}/response"
    local stderr_file="${request_dir}/stderr"
    local command_name
    local exit_code=0
    local arg1

    [ -f "${request_dir}/ready" ] || return 0
    [ ! -f "${request_dir}/done" ] || return 0
    [ -f "$command_file" ] || return 0

    command_name="$(cat "$command_file")"
    : > "$response_file"
    : > "$stderr_file"
    [ -f "$stdin_file" ] || : > "$stdin_file"

    set +e
    case "$command_name" in
        status)
            command_status > "$response_file" 2> "$stderr_file"
            exit_code=$?
            ;;
        capture)
            arg1="$(cat "${request_dir}/arg1" 2>/dev/null || printf '200')"
            command_capture "$arg1" > "$response_file" 2> "$stderr_file"
            exit_code=$?
            ;;
        transcript|logs)
            arg1="$(cat "${request_dir}/arg1" 2>/dev/null || printf '200')"
            command_transcript "$arg1" > "$response_file" 2> "$stderr_file"
            exit_code=$?
            ;;
        send)
            command_send "$stdin_file" > "$response_file" 2> "$stderr_file"
            exit_code=$?
            ;;
        ask-file)
            arg1="$(cat "${request_dir}/arg1" 2>/dev/null)"
            command_ask_file "$arg1" "$stdin_file" > "$response_file" 2> "$stderr_file"
            exit_code=$?
            ;;
        *)
            printf 'Unsupported bridge command: %s\n' "$command_name" > "$stderr_file"
            exit_code=2
            ;;
    esac
    set -e

    write_result "$request_dir" "$exit_code"
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

    while true; do
        for request_dir in "$request_root"/*; do
            [ -d "$request_dir" ] || continue
            process_request "$request_dir" || log "Failed to process bridge request: ${request_dir}"
        done
        sleep 1
    done
}

main "$@"
