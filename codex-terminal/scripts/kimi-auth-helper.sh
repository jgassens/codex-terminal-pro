#!/bin/bash

set -euo pipefail

KIMI_CODE_HOME="${KIMI_CODE_HOME:-/data/.kimi-code}"
AUTH_FILE="$KIMI_CODE_HOME/credentials.json"

ensure_kimi_home() {
    mkdir -p "$KIMI_CODE_HOME"
    chmod 700 "$KIMI_CODE_HOME"
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
    echo " Kimi Code auth: check/login/import"
    echo "================================================================"
    echo ""
    echo "Codex Terminal Pro stores Kimi Code account credentials at:"
    echo "  $AUTH_FILE"
    echo ""
    echo "Kimi Code uses a device-code login: it prints a link you open on"
    echo "any device with a browser and a code you enter there. No localhost"
    echo "callback is needed, so the flow works from this add-on."
    echo ""
    echo "This file contains access tokens. Treat it like a password:"
    echo "do not commit it, paste it into tickets, or share it in chat."
    echo ""
}

check_auth() {
    ensure_kimi_home

    echo "Kimi Code home: $KIMI_CODE_HOME"
    echo ""

    if [ -f "$AUTH_FILE" ]; then
        local mode
        mode=$(auth_mode)
        echo "Credentials file: present"
        echo "Permissions: $mode"
        if [ "$mode" = "600" ]; then
            echo "Status: permissions look correct"
        else
            echo "Status: permissions should be 600"
        fi
    else
        echo "Credentials file: missing"
        echo "Status: not authenticated yet, or credentials are stored elsewhere"
    fi
}

fix_permissions() {
    ensure_kimi_home

    if [ ! -f "$AUTH_FILE" ]; then
        echo "No credentials file found at $AUTH_FILE"
        return 1
    fi

    chmod 600 "$AUTH_FILE"
    echo "Fixed permissions on $AUTH_FILE"
}

device_login() {
    ensure_kimi_home

    if ! command -v kimi >/dev/null 2>&1; then
        echo "kimi command was not found in PATH."
        return 1
    fi

    local region_flag=""
    echo "Starting Kimi Code device-code login."
    echo ""
    echo "Which account region do you use?"
    echo "  1) Global (kimi.ai) - default"
    echo "  2) Mainland China (kimi.com)"
    printf "Enter your choice [1-2] (default: 1): " >&2
    local region_choice
    read -r region_choice
    case "$region_choice" in
        2) region_flag="--region mainland-cn" ;;
        *) region_flag="--region global" ;;
    esac

    echo ""
    echo "Follow the URL and one-time code printed by Kimi Code."
    echo "The URL is hard to copy from the terminal, so the add-on web page"
    echo "opens a dialog with it as a real link and a QR code."
    echo "Press Ctrl+C (or that panel's 'Cancel sign-in' button) to abort and"
    echo "return to this menu."
    echo ""
    # shellcheck disable=SC2086
    kimi login $region_flag || true

    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
        echo ""
        echo "Credentials file exists and permissions were set to 600."
    fi
}

show_import_instructions() {
    ensure_kimi_home

    echo "Fallback: authenticate locally and copy the credentials file"
    echo ""
    echo "On a trusted local machine with a browser:"
    echo "  1. Run: kimi login"
    echo "  2. Complete the device-code sign-in"
    echo "  3. Confirm this file exists:"
    echo "       ~/.kimi-code/credentials.json"
    echo "  4. Copy that file into this add-on's Kimi home:"
    echo "       $AUTH_FILE"
    echo "  5. In this helper, choose the permissions fix option."
    echo ""
    echo "Do not print, paste, commit, or share credentials.json. It"
    echo "contains access tokens."
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
        echo "  1) Check credentials/status"
        echo "  2) Start device-code login: kimi login"
        echo "  3) Show fallback import instructions"
        echo "  4) Fix credentials.json permissions to 600"
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
