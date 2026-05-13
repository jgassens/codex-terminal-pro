#!/bin/bash

set -uo pipefail

show_banner() {
    clear
    echo "================================================================"
    echo " Codex Terminal Pro"
    echo "================================================================"
    echo ""
}

show_menu() {
    echo "Working directory: /config"
    if command -v codex >/dev/null 2>&1; then
        echo "Codex CLI: available"
    else
        echo "Codex CLI: not found"
    fi
    echo ""
    echo "Choose an action:"
    echo ""
    echo "  1) Start Codex in /config"
    echo "  2) Open regular shell in /config"
    echo "  3) Codex auth: check/login/import"
    echo "  4) Run Home Assistant config check, if available"
    echo "  5) Reload Home Assistant YAML, if available"
    echo "  6) Restart Home Assistant, only after confirmation"
    echo "  7) Exit"
    echo ""
}

get_user_choice() {
    local choice
    printf "Enter your choice [1-7] (default: 1): " >&2
    read -r choice
    if [ -z "$choice" ]; then
        choice=1
    fi
    echo "$choice" | tr -d '[:space:]'
}

start_codex() {
    cd /config
    echo "Starting Codex in /config..."
    sleep 1
    codex
}

open_shell() {
    cd /config
    echo "Opening shell in /config. Type 'exit' to return to this menu."
    sleep 1
    bash
}

run_auth_helper() {
    if command -v codex-auth-helper >/dev/null 2>&1; then
        codex-auth-helper
    elif [ -x /opt/scripts/codex-auth-helper.sh ]; then
        /opt/scripts/codex-auth-helper.sh
    else
        echo "codex-auth-helper is not installed."
        pause
    fi
}

run_ha_config_check() {
    if ! command -v ha >/dev/null 2>&1; then
        echo "Home Assistant CLI (ha) is not available."
        pause
        return
    fi

    echo "Running: ha core check"
    ha core check || true
    pause
}

reload_ha_yaml() {
    if ! command -v ha >/dev/null 2>&1; then
        echo "Home Assistant CLI (ha) is not available."
        pause
        return
    fi

    if ha core --help 2>/dev/null | grep -q "reload"; then
        echo "Running: ha core reload"
        ha core reload || true
    else
        echo "Home Assistant YAML reload is not exposed by this ha CLI build."
        echo "Run a config check first, then reload from Home Assistant UI if needed."
    fi
    pause
}

restart_ha() {
    if ! command -v ha >/dev/null 2>&1; then
        echo "Home Assistant CLI (ha) is not available."
        pause
        return
    fi

    echo "Restarting Home Assistant can interrupt automations and dashboards."
    echo "Run a config check first. To continue, type exactly: restart"
    printf "> " >&2
    read -r confirmation

    if [ "$confirmation" = "restart" ]; then
        echo "Running: ha core restart"
        ha core restart || true
    else
        echo "Restart cancelled."
    fi
    pause
}

pause() {
    echo ""
    printf "Press Enter to return to menu..." >&2
    read -r _
}

main() {
    while true; do
        show_banner
        show_menu
        choice=$(get_user_choice)

        case "$choice" in
            1) start_codex ;;
            2) open_shell ;;
            3) run_auth_helper ;;
            4) run_ha_config_check ;;
            5) reload_ha_yaml ;;
            6) restart_ha ;;
            7) echo "Goodbye."; exit 0 ;;
            *)
                echo "Invalid choice: $choice"
                pause
                ;;
        esac
    done
}

main "$@"
