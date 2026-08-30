#!/bin/bash

set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/.claude}"
AUTH_FILE="$CLAUDE_CONFIG_DIR/.credentials.json"
TOKEN_ENV_FILE="$CLAUDE_CONFIG_DIR/oauth-token.env"
AUTH_CODE_FILE="/config/auth-code.txt"

ensure_claude_home() {
    mkdir -p "$CLAUDE_CONFIG_DIR"
    chmod 700 "$CLAUDE_CONFIG_DIR"
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
    echo " Claude Code auth: check/login/import"
    echo "================================================================"
    echo ""
    echo "Codex Terminal Pro stores Claude Code account credentials at:"
    echo "  $AUTH_FILE"
    echo ""
    echo "Claude Code login prints a URL you open on any device with a"
    echo "browser, then asks you to paste a one-time code back into this"
    echo "terminal. No localhost callback is needed, so the flow works from"
    echo "this add-on."
    echo ""
    echo "These files contain access tokens. Treat them like a password:"
    echo "do not commit them, paste them into tickets, or share them in chat."
    echo ""
}

check_auth() {
    ensure_claude_home

    echo "Claude Code home: $CLAUDE_CONFIG_DIR"
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

    if [ -f "$TOKEN_ENV_FILE" ]; then
        echo "Long-lived OAuth token file: present ($TOKEN_ENV_FILE)"
    fi
}

fix_permissions() {
    ensure_claude_home

    local fixed=1
    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
        echo "Fixed permissions on $AUTH_FILE"
        fixed=0
    fi
    if [ -f "$TOKEN_ENV_FILE" ]; then
        chmod 600 "$TOKEN_ENV_FILE"
        echo "Fixed permissions on $TOKEN_ENV_FILE"
        fixed=0
    fi
    if [ "$fixed" -ne 0 ]; then
        echo "No credential files found under $CLAUDE_CONFIG_DIR"
        return 1
    fi
}

interactive_login() {
    ensure_claude_home

    if ! command -v claude >/dev/null 2>&1; then
        echo "claude command was not found in PATH."
        return 1
    fi

    echo "Starting Claude Code so you can sign in."
    echo ""
    echo "Claude Code will print a URL. Open it on any device (your phone or"
    echo "computer), sign in with your Claude subscription, and paste the"
    echo "code it gives you back into this terminal."
    echo ""
    echo "The printed URL wraps across lines and is hard to copy from the"
    echo "terminal. Once it appears, the add-on web page opens a dialog with"
    echo "the link as a real link, a QR code, and a field for the code."
    echo ""
    echo "To abort the sign-in, use the 'Cancel sign-in' button in that panel"
    echo "(Claude Code's login screen ignores Ctrl+C); you return to this menu."
    echo ""
    echo "Tips for pasting in the web terminal:"
    echo "  - Try Ctrl+Shift+V or right-click paste"
    echo "  - Use the Paste panel in the add-on web page header"
    echo "  - On mobile, long-press usually shows a paste option"
    echo ""
    echo "If pasting refuses to work, exit Claude Code, save the code to"
    echo "$AUTH_CODE_FILE and use the paste-from-file option instead."
    echo ""
    printf "Press Enter to launch Claude Code..." >&2
    read -r _
    claude || true

    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
        echo ""
        echo "Credentials file exists and permissions were set to 600."
    fi
}

login_code_from_file() {
    ensure_claude_home

    if ! command -v claude >/dev/null 2>&1; then
        echo "claude command was not found in PATH."
        return 1
    fi

    echo "Looking for a login code in: $AUTH_CODE_FILE"
    echo ""

    if [ ! -f "$AUTH_CODE_FILE" ]; then
        echo "File not found: $AUTH_CODE_FILE"
        echo ""
        echo "To use this method:"
        echo "  1. Start the login option first and open the printed URL"
        echo "  2. Save the code you receive into $AUTH_CODE_FILE"
        echo "     (create the file in Home Assistant's config share)"
        echo "  3. Run this option again"
        return 1
    fi

    local auth_code
    auth_code=$(head -n 1 "$AUTH_CODE_FILE" | tr -d '[:space:]')
    if [ -z "$auth_code" ]; then
        echo "File exists but is empty: $AUTH_CODE_FILE"
        return 1
    fi

    echo "Code found. Feeding it to Claude Code..."
    printf '%s\n' "$auth_code" | claude || true

    rm -f "$AUTH_CODE_FILE"
    echo "Removed $AUTH_CODE_FILE"

    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
        echo "Credentials file exists and permissions were set to 600."
    fi
}

store_long_lived_token() {
    ensure_claude_home

    echo "Long-lived token: mint on a trusted machine, store here"
    echo ""
    echo "On a trusted local machine with a browser:"
    echo "  1. Run: claude setup-token"
    echo "  2. Complete the browser sign-in with your Claude subscription"
    echo "  3. Copy the token it prints (it is shown once)"
    echo ""
    echo "The token will be stored with permissions 600 at:"
    echo "  $TOKEN_ENV_FILE"
    echo ""
    printf "Paste the token now (input is hidden; empty cancels): " >&2
    local token
    read -r -s token
    echo ""

    if [ -z "$token" ]; then
        echo "Cancelled; nothing was stored."
        return 1
    fi

    umask 177
    printf 'export CLAUDE_CODE_OAUTH_TOKEN="%s"\n' "$token" > "$TOKEN_ENV_FILE"
    chmod 600 "$TOKEN_ENV_FILE"
    echo "Token stored. New shells pick it up automatically; restart the"
    echo "add-on (or reload the session) so the terminal pane sees it."
}

show_import_instructions() {
    ensure_claude_home

    echo "Fallback: authenticate locally and copy the credentials file"
    echo ""
    echo "On a trusted local machine with a browser:"
    echo "  1. Run: claude"
    echo "  2. Complete the sign-in with your Claude subscription"
    echo "  3. Confirm this file exists:"
    echo "       ~/.claude/.credentials.json"
    echo "  4. Copy that file into this add-on's Claude home:"
    echo "       $AUTH_FILE"
    echo "  5. In this helper, choose the permissions fix option."
    echo ""
    echo "Do not print, paste, commit, or share .credentials.json. It"
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
        echo "  2) Sign in: launch Claude Code and paste the code"
        echo "  3) Sign in with a code saved to $AUTH_CODE_FILE"
        echo "  4) Store a long-lived token from: claude setup-token"
        echo "  5) Show fallback import instructions"
        echo "  6) Fix credential file permissions to 600"
        echo "  7) Exit"
        echo ""
        printf "Enter your choice [1-7]: " >&2
        read -r choice

        case "$choice" in
            1)
                echo ""
                check_auth
                pause
                ;;
            2)
                echo ""
                interactive_login || true
                pause
                ;;
            3)
                echo ""
                login_code_from_file || true
                pause
                ;;
            4)
                echo ""
                store_long_lived_token || true
                pause
                ;;
            5)
                echo ""
                show_import_instructions
                pause
                ;;
            6)
                echo ""
                fix_permissions || true
                pause
                ;;
            7)
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
