#!/usr/bin/env bash

# Loaded only by the trusted raw Shell pane. It makes accidentally typed
# `,,ha ...` or `,, ha ...` lines behave like direct human shell commands.
if [ "${CODEX_TERMINAL_HUMAN_SHELL:-}" != "1" ] || [[ "$-" != *i* ]]; then
    return 0 2>/dev/null || exit 0
fi

# Raw Shell mode gets its own prompt so commands do not disappear into output.
export PS1='\[\033[1;35m\]ctp-shell\[\033[0m\] \[\033[1;34m\]\w\[\033[0m\] \[\033[1;31m\]\$\[\033[0m\] '

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

__codex_terminal_repair_fanout_text() {
    local text="$1"
    local max_lag=3
    local repaired=""
    local pending=()
    local char=""
    local found=0
    local i=0
    local j=0

    for ((i = 0; i < ${#text}; i += 1)); do
        char="${text:i:1}"
        found=0

        for ((j = 0; j < ${#pending[@]} && j < max_lag; j += 1)); do
            if [ "${pending[$j]}" = "$char" ]; then
                unset 'pending[j]'
                pending=("${pending[@]}")
                found=1
                break
            fi
        done

        if [ "$found" -eq 1 ]; then
            continue
        fi

        repaired="${repaired}${char}"
        pending+=("$char")
        if [ "${#pending[@]}" -gt "$max_lag" ]; then
            pending=("${pending[@]:1}")
        fi
    done

    printf '%s\n' "$repaired"
}

__codex_terminal_run_repaired_prefixed_command() {
    local raw="$*"
    local repaired=""
    local repaired_name=""
    local original_len=0
    local repaired_len=0
    local reduction=0
    local repaired_parts=()

    repaired="$(__codex_terminal_repair_fanout_text "$raw")"
    repaired="${repaired#"${repaired%%[![:space:]]*}"}"
    repaired="${repaired%"${repaired##*[![:space:]]}"}"
    original_len="${#raw}"
    repaired_len="${#repaired}"

    if [ "$original_len" -gt 0 ]; then
        reduction=$(( (original_len - repaired_len) * 100 / original_len ))
    fi

    read -r -a repaired_parts <<< "$repaired"
    repaired_name="${repaired_parts[0]:-}"

    if [ "$reduction" -ge 35 ] && [ -n "$repaired_name" ] && command -v "$repaired_name" >/dev/null 2>&1; then
        "${repaired_parts[@]}"
        return $?
    fi

    __codex_terminal_run_prefixed_command "$@"
}

command_not_found_handle() {
    local command_name="${1:-}"
    shift || true

    if [ "$command_name" = ",," ]; then
        if [ "$#" -eq 0 ]; then
            printf 'Codex Terminal Pro: type a command after ,,\n' >&2
            return 127
        fi

        __codex_terminal_run_repaired_prefixed_command "$@"
        return $?
    fi

    if [[ "$command_name" == ,,* ]]; then
        local stripped="${command_name#,,}"
        if [ -z "$stripped" ]; then
            printf 'Codex Terminal Pro: type a command after ,,\n' >&2
            return 127
        fi

        __codex_terminal_run_repaired_prefixed_command "$stripped" "$@"
        return $?
    fi

    printf 'bash: %s: command not found\n' "$command_name" >&2
    return 127
}
