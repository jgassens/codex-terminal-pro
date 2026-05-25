#!/usr/bin/env bash

# Loaded only by the trusted raw Shell pane. It makes accidentally typed
# `,,ha ...` or `,, ha ...` lines behave like direct human shell commands.
if [ "${CODEX_TERMINAL_HUMAN_SHELL:-}" != "1" ] || [[ "$-" != *i* ]]; then
    return 0 2>/dev/null || exit 0
fi

__codex_terminal_run_prefixed_command() {
    local command_name="$1"
    local deduped=""
    local previous=""
    local char=""
    local i=0
    shift || true

    if command -v "$command_name" >/dev/null 2>&1; then
        "$command_name" "$@"
        return $?
    fi

    for ((i = 0; i < ${#command_name}; i += 1)); do
        char="${command_name:i:1}"
        if [ "$char" != "$previous" ]; then
            deduped="${deduped}${char}"
        fi
        previous="$char"
    done

    if [ "$deduped" != "$command_name" ] && command -v "$deduped" >/dev/null 2>&1; then
        "$deduped" "$@"
        return $?
    fi

    "$command_name" "$@"
}

command_not_found_handle() {
    local command_name="${1:-}"
    shift || true

    if [ "$command_name" = ",," ]; then
        if [ "$#" -eq 0 ]; then
            printf 'Codex Terminal Pro: type a command after ,,\n' >&2
            return 127
        fi

        __codex_terminal_run_prefixed_command "$@"
        return $?
    fi

    if [[ "$command_name" == ,,* ]]; then
        local stripped="${command_name#,,}"
        if [ -z "$stripped" ]; then
            printf 'Codex Terminal Pro: type a command after ,,\n' >&2
            return 127
        fi

        __codex_terminal_run_prefixed_command "$stripped" "$@"
        return $?
    fi

    printf 'bash: %s: command not found\n' "$command_name" >&2
    return 127
}
