#!/usr/bin/env sh

set -eu

usage() {
    cat <<'USAGE'
Usage: codex-terminal-pro-attach [command] [args...]

Run this from a Home Assistant SSH shell that has /config and Docker access.
From the raw HA OS host shell, run the same file from Home Assistant's config
directory path instead.

Commands:
  attach     Attach to the live Codex Terminal Pro tmux session. Default.
  shell      Open a /config shell inside the Codex Terminal Pro add-on.
  send       Send text to the Codex tmux pane and press Enter.
  ask-file   Ask Codex to write an answer to a file under /config.
  capture    Print recent visible tmux pane output. Default: 200 lines.
  transcript Print recent internal transcript lines. Default: 200 lines.
  logs       Follow /data/logs/codex-terminal.log inside the add-on.
  status     Show the discovered container and tmux session status.
  container  Print the discovered Codex Terminal Pro container name.

Examples:
  codex-terminal-pro-attach send "say hello"
  codex-terminal-pro-attach capture 120
  codex-terminal-pro-attach transcript 120
  codex-terminal-pro-attach ask-file /config/codex-ssh-reply.txt "write a one-line status"

Override discovery with CODEX_TERMINAL_PRO_CONTAINER=<container-name>.
USAGE
}

find_container() {
    if [ -n "${CODEX_TERMINAL_PRO_CONTAINER:-}" ]; then
        printf '%s\n' "$CODEX_TERMINAL_PRO_CONTAINER"
        return 0
    fi

    docker ps --format '{{.Names}}' \
        | grep -E '^addon_.*_codex_terminal_pro$' \
        | head -n 1
}

require_docker() {
    if command -v docker >/dev/null 2>&1; then
        return 0
    fi

    cat >&2 <<'ERROR'
docker is not available in this shell.

Use a Home Assistant OS host shell, or an SSH add-on/session with host container
access. Codex Terminal Pro itself does not need to expose a separate SSH server.
ERROR
    exit 1
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

ask_file_command() {
    container="$1"
    shift

    if [ "$#" -lt 1 ]; then
        printf 'Usage: codex-terminal-pro-attach ask-file /config/path.txt [prompt]\n' >&2
        exit 2
    fi

    output_path="$1"
    shift

    case "$output_path" in
        /config/*)
            ;;
        *)
            printf 'ask-file output path must be under /config, got: %s\n' "$output_path" >&2
            exit 2
            ;;
    esac

    if [ "$#" -gt 0 ]; then
        request="$*"
    else
        if [ -t 0 ]; then
            printf 'Usage: codex-terminal-pro-attach ask-file /config/path.txt "prompt text"\n' >&2
            printf 'Or pipe prompt text on stdin after the output path.\n' >&2
            exit 2
        fi
        request="$(cat)"
    fi

    if [ -z "$request" ]; then
        printf 'ask-file needs a prompt argument or prompt text on stdin.\n' >&2
        exit 2
    fi

    {
        printf 'Please answer this Codex Terminal Pro SSH-side request by writing your answer to `%s`.\n' "$output_path"
        printf 'Keep the file concise and do not read, print, or copy secrets. '
        printf 'After writing the file, say only that `%s` is ready.\n\n' "$output_path"
        printf 'Request:\n%s\n' "$request"
    } | send_stdin_to_codex "$container" true

    printf 'Sent request to Codex. Read the answer from SSH with:\n'
    printf '  cat %s\n' "$output_path"
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

    require_docker
    container="$(find_container || true)"

    if [ -z "$container" ]; then
        cat >&2 <<'ERROR'
Could not find a running Codex Terminal Pro add-on container.

Start the add-on first, then retry. If this is a non-standard install, set
CODEX_TERMINAL_PRO_CONTAINER to the container name from `docker ps`.
ERROR
        exit 1
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
            ask_file_command "$container" "$@"
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

main "$@"
