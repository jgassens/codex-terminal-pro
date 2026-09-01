#!/bin/sh

# Every login shell parses /etc/profile.d. Keep this wrapper strictly POSIX and
# load the Bash-only command-not-found implementation only when Bash is active.
if [ -n "${BASH_VERSION:-}" ] && [ -r /opt/scripts/codex-terminal-shell-dispatch.sh ]; then
    # shellcheck disable=SC1091
    . /opt/scripts/codex-terminal-shell-dispatch.sh
fi
