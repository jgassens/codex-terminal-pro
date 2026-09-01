#!/usr/bin/env sh

set -eu

request_dir=""

cleanup() {
    if [ -n "$request_dir" ] && [ -d "$request_dir" ]; then
        rm -rf "$request_dir"
    fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
    cat <<'USAGE'
Usage: codex-terminal-pro-attach [command] [args...]

Run this from a Home Assistant SSH shell with /config access. Docker access is
used when available for interactive attach/shell. Without Docker, only status
uses the read-limited /config mailbox bridge.

Commands:
  attach     Attach to the live tmux session. Requires Docker/host access.
  shell      Open a /config shell inside the add-on. Requires Docker/host access.
  send       Send text to the Codex tmux pane and press Enter.
  ask-file   Disabled: asynchronous writes cannot be secured on shared /config.
  capture    Print recent visible tmux pane output. Default: 200 lines.
  transcript Print recent internal transcript lines. Default: 200 lines.
  logs       Follow the internal transcript. Requires Docker/host access.
  status     Show the discovered container and tmux session status.
  container  Print the container name. Requires Docker/host access.

Examples:
  codex-terminal-pro-attach send "say hello"
  codex-terminal-pro-attach capture 120
  codex-terminal-pro-attach transcript 120

Override discovery with CODEX_TERMINAL_PRO_CONTAINER=<container-name>.
Override bridge wait time with CODEX_TERMINAL_PRO_BRIDGE_TIMEOUT=<seconds>.
USAGE
}

find_container() {
    if [ -n "${CODEX_TERMINAL_PRO_CONTAINER:-}" ]; then
        printf '%s\n' "$CODEX_TERMINAL_PRO_CONTAINER"
        return 0
    fi

    docker ps --format '{{.Names}}' 2>/dev/null \
        | grep -E '^addon_.*_codex_terminal_pro$' \
        | head -n 1
}

docker_exec_interactive() {
    container="$1"
    shift

    if [ -t 0 ] && [ -t 1 ]; then
        exec docker exec -it "$container" "$@"
    fi

    exec docker exec -i "$container" "$@"
}

validate_line_count() {
    lines="$1"

    case "$lines" in
        ''|*[!0-9]*)
            printf 'Line count must be a positive integer, got: %s\n' "$lines" >&2
            exit 2
            ;;
        0)
            printf 'Line count must be greater than zero.\n' >&2
            exit 2
            ;;
    esac
}

bridge_status_request() {
    bridge_root="${CODEX_TERMINAL_PRO_BRIDGE_DIR:-/config/.codex-terminal-pro/ssh-bridge}"
    request_root="${bridge_root}/requests"
    timeout="${CODEX_TERMINAL_PRO_BRIDGE_TIMEOUT:-30}"

    # The bridge refuses request inputs that another user can modify.  Do not
    # inherit a permissive umask from the host SSH shell when creating them.
    umask 077

    case "$timeout" in
        ''|*[!0-9]*)
            timeout=30
            ;;
    esac

    if ! mkdir -p "$request_root"; then
        printf 'Could not create bridge request directory: %s\n' "$request_root" >&2
        exit 1
    fi

    request_dir="$(mktemp -d "${request_root}/request.XXXXXX")"
    printf '%s\n' status > "${request_dir}/command"
    touch "${request_dir}/ready"

    elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if [ -f "${request_dir}/done" ]; then
            if [ -s "${request_dir}/stderr" ]; then
                cat "${request_dir}/stderr" >&2
            fi
            if [ -f "${request_dir}/response" ]; then
                cat "${request_dir}/response"
            fi
            if [ -f "${request_dir}/exit_code" ]; then
                exit_code="$(cat "${request_dir}/exit_code")"
            else
                exit_code=1
            fi
            exit "$exit_code"
        fi

        sleep 1
        elapsed=$((elapsed + 1))
    done

    printf 'Timed out waiting for Codex Terminal Pro SSH bridge after %s seconds.\n' "$timeout" >&2
    printf 'The add-on may need to be updated/restarted so the bridge daemon starts.\n' >&2
    exit 1
}

docker_unavailable() {
    cat >&2 <<'ERROR'
Interactive attach, shell, and container discovery need Docker access.

This SSH shell can still use the read-limited mailbox bridge for:
  /config/codex-terminal-pro-attach status

Prompt injection, terminal capture/transcripts, and asynchronous ask-file writes
are intentionally unavailable through shared /config. They require Docker
access to the add-on container.

If bridge commands time out, update/restart Codex Terminal Pro so the bridge
daemon starts inside that add-on.
ERROR
    exit 1
}

send_stdin_to_codex() {
    container="$1"
    press_enter="$2"

    docker exec -i "$container" bash -lc '
        set -euo pipefail
        press_enter="${1:-true}"
        target="${CODEX_TMUX_TARGET:-codex-terminal:0.0}"

        if ! tmux -f /data/.tmux.conf has-session -t codex-terminal 2>/dev/null; then
            echo "Codex Terminal Pro tmux session is not running." >&2
            exit 1
        fi

        tmp="$(mktemp)"
        buffer="codex-terminal-host-input-$$"
        trap '\''rm -f "$tmp"'\'' EXIT

        cat > "$tmp"
        tmux -f /data/.tmux.conf load-buffer -b "$buffer" "$tmp"
        tmux -f /data/.tmux.conf paste-buffer -p -d -b "$buffer" -t "$target"

        if [ "$press_enter" = "true" ]; then
            tmux -f /data/.tmux.conf send-keys -t "$target" Enter
        fi
    ' sh "$press_enter"
}

capture_pane() {
    container="$1"
    lines="${2:-200}"

    validate_line_count "$lines"
    docker exec "$container" bash -lc '
        set -euo pipefail
        lines="$1"
        target="${CODEX_TMUX_TARGET:-codex-terminal:0.0}"

        if ! tmux -f /data/.tmux.conf has-session -t codex-terminal 2>/dev/null; then
            echo "Codex Terminal Pro tmux session is not running." >&2
            exit 1
        fi

        tmux -f /data/.tmux.conf capture-pane -p -J -t "$target" -S "-${lines}"
    ' sh "$lines"
}

print_transcript_tail() {
    container="$1"
    lines="${2:-200}"

    validate_line_count "$lines"
    docker exec "$container" bash -lc '
        set -euo pipefail
        lines="$1"
        transcript="/data/logs/codex-terminal.log"

        if [ ! -f "$transcript" ]; then
            echo "Transcript not found at $transcript." >&2
            echo "It may be disabled with terminal_transcript_enabled: false." >&2
            exit 1
        fi

        tail -n "$lines" "$transcript"
    ' sh "$lines"
}

send_text_command() {
    container="$1"
    shift

    if [ "$#" -gt 0 ]; then
        printf '%s' "$*" | send_stdin_to_codex "$container" true
    else
        if [ -t 0 ]; then
            printf 'Usage: codex-terminal-pro-attach send "prompt text"\n' >&2
            printf 'Or pipe prompt text on stdin.\n' >&2
            exit 2
        fi
        send_stdin_to_codex "$container" true
    fi
}

main() {
    command_name="${1:-attach}"
    if [ "$#" -gt 0 ]; then
        shift
    fi

    case "$command_name" in
        attach|shell|send|ask-file|capture|transcript|logs|status|container|help|-h|--help)
            ;;
        *)
            printf 'Unknown command: %s\n\n' "$command_name" >&2
            usage >&2
            exit 2
            ;;
    esac

    if [ "$command_name" = "help" ] || [ "$command_name" = "-h" ] || [ "$command_name" = "--help" ]; then
        usage
        exit 0
    fi

    container=""
    if command -v docker >/dev/null 2>&1; then
        container="$(find_container || true)"
    fi

    if [ -z "$container" ]; then
        case "$command_name" in
            status)
                bridge_status_request
                ;;
            attach|shell|send|ask-file|capture|transcript|logs|container)
                docker_unavailable
                ;;
        esac
    fi

    case "$command_name" in
        container)
            printf '%s\n' "$container"
            ;;
        status)
            printf 'Container: %s\n' "$container"
            docker exec "$container" bash -lc '
                if tmux -f /data/.tmux.conf has-session -t codex-terminal 2>/dev/null; then
                    echo "tmux: codex-terminal session is running"
                else
                    echo "tmux: codex-terminal session is not running"
                fi
                printf "Codex home: %s\n" "${CODEX_HOME:-/data/.codex}"
                printf "Config dir: /config\n"
            '
            ;;
        logs)
            docker_exec_interactive "$container" tail -f /data/logs/codex-terminal.log
            ;;
        transcript)
            print_transcript_tail "$container" "${1:-200}"
            ;;
        capture)
            capture_pane "$container" "${1:-200}"
            ;;
        send)
            send_text_command "$container" "$@"
            ;;
        ask-file)
            printf 'ask-file is disabled because shared /config paths can change before an asynchronous Codex write.\n' >&2
            exit 2
            ;;
        shell)
            docker_exec_interactive "$container" bash -lc 'cd /config && exec bash -l'
            ;;
        attach)
            docker_exec_interactive "$container" bash -lc '
                cd /config
                if ! tmux -f /data/.tmux.conf has-session -t codex-terminal 2>/dev/null; then
                    echo "Codex Terminal Pro tmux session is not running yet."
                    echo "Opening a /config shell instead."
                    exec bash -l
                fi
                exec tmux -f /data/.tmux.conf attach-session -t codex-terminal
            '
            ;;
    esac
}

if [ "${CODEX_TERMINAL_HOST_ATTACH_LIBRARY_ONLY:-false}" != "true" ]; then
    main "$@"
fi
