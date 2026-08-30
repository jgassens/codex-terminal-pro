#!/bin/bash

set -euo pipefail

KIMI_CODE_HOME="${KIMI_CODE_HOME:-/data/.kimi-code}"
# Kimi keeps its token in a directory, one JSON file per signed-in account,
# and records the provider and model it can use in config.toml.
CRED_DIR="$KIMI_CODE_HOME/credentials"
CONFIG_FILE="$KIMI_CODE_HOME/config.toml"

token_files() {
    find "$CRED_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null
}

has_token() {
    [ -n "$(token_files)" ]
}

has_model() {
    [ -f "$CONFIG_FILE" ] || return 1
    grep -qE '^[[:space:]]*(default_model[[:space:]]*=|\[models|\[providers)' "$CONFIG_FILE"
}

ensure_kimi_home() {
    mkdir -p "$KIMI_CODE_HOME"
    chmod 700 "$KIMI_CODE_HOME"
}

auth_mode() {
    if has_token; then
        stat -c "%a" $(token_files) 2>/dev/null | head -n 1 || echo "unknown"
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
    echo "  $CRED_DIR/"
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

    if has_token; then
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

    if ! has_token; then
        echo "No credentials found in $CRED_DIR"
        return 1
    fi

    chmod 600 $(token_files)
    echo "Fixed permissions on the credentials in $CRED_DIR"
}

device_login() {
    ensure_kimi_home

    if ! command -v kimi >/dev/null 2>&1; then
        echo "kimi command was not found in PATH."
        return 1
    fi

    if has_token && ! has_model; then
        echo "A previous sign-in left a token behind but never registered a"
        echo "model, which is why Kimi cannot answer. Kimi sends that token"
        echo "when signing in again, and its server rejects the attempt, so"
        echo "the stale token has to be set aside first."
        echo ""
        printf "Set the old token aside and sign in fresh? [Y/n]: " >&2
        local reset_choice
        read -r reset_choice
        case "$reset_choice" in
            n|N|no|NO)
                echo "Keeping it. The sign-in below will most likely fail."
                ;;
            *)
                local backup="${CRED_DIR}.superseded-$(date +%Y%m%d-%H%M%S)"
                if mv "$CRED_DIR" "$backup"; then
                    echo "Moved the old token to $backup"
                    echo "It can be deleted once the new sign-in works."
                else
                    echo "Could not move $CRED_DIR; sign-in may fail."
                fi
                ;;
        esac
        echo ""
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

    if has_token; then
        chmod 600 $(token_files)
        echo ""
        echo "Credentials are present and permissions were set to 600."
        if ! has_model; then
            echo ""
            echo "Warning: no model is configured yet, so consulting Kimi will"
            echo "still fail. Sign in again to let it finish registering one."
        fi
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
    echo "       $CRED_DIR/"
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
