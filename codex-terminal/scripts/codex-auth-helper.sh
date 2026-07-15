#!/bin/bash

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-/data/.codex}"
AUTH_FILE="$CODEX_HOME/auth.json"
CONFIG_FILE="$CODEX_HOME/config.toml"

ensure_codex_home() {
    mkdir -p "$CODEX_HOME"
    chmod 700 "$CODEX_HOME"

    touch "$CONFIG_FILE"
    chmod 644 "$CONFIG_FILE"

    /opt/scripts/codex-config-set "$CONFIG_FILE" cli_auth_credentials_store '"file"'
}

auth_mode() {
    if [ -f "$AUTH_FILE" ]; then
        stat -c "%a" "$AUTH_FILE" 2>/dev/null || echo "unknown"
    else
        echo "missing"
    fi
}

show_header() {
    clear
    echo "================================================================"
    echo " Codex auth: check/login/import"
    echo "================================================================"
    echo ""
    echo "Codex Terminal Pro stores Codex account credentials at:"
    echo "  $AUTH_FILE"
    echo ""
    echo "Use device-code login or import auth.json for this add-on."
    echo "Plain browser login redirects to localhost on your computer, not"
    echo "the Home Assistant container, so it usually cannot complete here."
    echo ""
    echo "This file contains access tokens. Treat it like a password:"
    echo "do not commit it, paste it into tickets, or share it in chat."
    echo ""
}

check_auth() {
    ensure_codex_home

    echo "Codex home: $CODEX_HOME"
    echo "Config file: $CONFIG_FILE"
    echo "Credential storage: file"
    echo ""

    if [ -f "$AUTH_FILE" ]; then
        local mode
        mode=$(auth_mode)
        echo "Auth file: present"
        echo "Permissions: $mode"
        if [ "$mode" = "600" ]; then
            echo "Status: permissions look correct"
        else
            echo "Status: permissions should be 600"
        fi
    else
        echo "Auth file: missing"
        echo "Status: not authenticated yet, or credentials are stored elsewhere"
    fi
}

fix_permissions() {
    ensure_codex_home

    if [ ! -f "$AUTH_FILE" ]; then
        echo "No auth file found at $AUTH_FILE"
        return 1
    fi

    chmod 600 "$AUTH_FILE"
    echo "Fixed permissions on $AUTH_FILE"
}

device_login() {
    ensure_codex_home

    if ! command -v codex >/dev/null 2>&1; then
        echo "codex command was not found in PATH."
        return 1
    fi

    echo "Starting Codex device-code login."
    echo ""
    echo "Follow the URL and one-time code printed by Codex."
    echo "If device-code login is not enabled for your account or workspace,"
    echo "Codex may fall back to browser login. If you see a localhost:1455"
    echo "callback URL, cancel and use the fallback import instructions instead."
    echo ""
    codex login --device-auth

    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
        echo ""
        echo "Auth file exists and permissions were set to 600."
    fi
}

show_import_instructions() {
    ensure_codex_home

    echo "Fallback: authenticate locally and copy the auth cache"
    echo ""
    echo "Use this when device-code login falls back to a localhost callback."
    echo ""
    echo "On a trusted local machine with a browser:"
    echo "  1. Run login with an explicit file-credential override:"
    echo "       codex -c 'cli_auth_credentials_store=\"file\"' login"
    echo "  2. Confirm this file exists:"
    echo "       ~/.codex/auth.json"
    echo "  3. Copy that file into this add-on's Codex home:"
    echo "       $AUTH_FILE"
    echo "  4. In this helper, choose the permissions fix option."
    echo ""
    echo "Do not print, paste, commit, or share auth.json. It contains access tokens."
}

pause() {
    echo ""
    printf "Press Enter to continue..." >&2
    read -r _
}

main() {
    while true; do
        show_header
        check_auth
        echo ""
        echo "Options:"
        echo "  1) Check auth file/status"
        echo "  2) Start device-code login: codex login --device-auth"
        echo "  3) Show fallback import instructions"
        echo "  4) Fix auth.json permissions to 600"
        echo "  5) Exit"
        echo ""
        printf "Enter your choice [1-5]: " >&2
        read -r choice

        case "$choice" in
            1)
                echo ""
                check_auth
                pause
                ;;
            2)
                echo ""
                device_login || true
                pause
                ;;
            3)
                echo ""
                show_import_instructions
                pause
                ;;
            4)
                echo ""
                fix_permissions || true
                pause
                ;;
            5)
                exit 0
                ;;
            *)
                echo "Invalid choice"
                sleep 1
                ;;
        esac
    done
}

main "$@"
