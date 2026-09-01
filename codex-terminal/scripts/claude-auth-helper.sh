#!/bin/bash

set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/.claude}"
AUTH_FILE="$CLAUDE_CONFIG_DIR/.credentials.json"

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
        if [ "$mode" != "600" ]; then
            echo "Note: permissions should be 600 - use the fix option in this menu."
        fi
    else
        echo "Credentials file: missing"
    fi

    # The file proves nothing on its own: signing out, or a refresh the server
    # rejects, leaves it in place with the tokens emptied. Reporting "present,
    # 600" as if it were a login is what makes a dead account look healthy, so
    # ask Claude Code itself whether the account can actually authenticate.
    echo ""
    echo "Account status reported by Claude Code:"
    if command -v claude >/dev/null 2>&1; then
        claude auth status 2>&1 | sed 's/^/  /'
    else
        echo "  claude command was not found in PATH"
    fi
}

fix_permissions() {
    ensure_claude_home

    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
        echo "Fixed permissions on $AUTH_FILE"
    else
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

    echo "Starting the Claude Code sign-in."
    echo ""
    echo "This runs 'claude auth login', the CLI's own sign-in command."
    echo "Launching the chat interface instead only signs you in if you"
    echo "remember to type /login once it is up, which is easy to miss."
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
    echo "  - Use the sign-in dialog's code field on the add-on web page"
    echo "  - On mobile, long-press usually shows a paste option"
    echo ""
    printf "Press Enter to start the sign-in..." >&2
    read -r _
    claude auth login || true

    if [ -f "$AUTH_FILE" ]; then
        chmod 600 "$AUTH_FILE"
    fi

    # Report what the account can actually do now rather than that a file was
    # written: a half-finished flow leaves the file behind without a token.
    echo ""
    echo "Account status reported by Claude Code:"
    claude auth status 2>&1 | sed 's/^/  /'
}

show_import_instructions() {
    ensure_claude_home

    echo "Fallback: authenticate locally and copy the credentials file"
    echo ""
    echo "On a trusted local Linux/WSL machine with a browser:"
    echo "  1. Run: claude"
    echo "  2. Complete the sign-in with your Claude subscription"
    echo "  3. Confirm this file exists:"
    echo "       ~/.claude/.credentials.json"
    echo "  4. Copy that file into this add-on's Claude home:"
    echo "       $AUTH_FILE"
    echo "  5. In this helper, choose the permissions fix option."
    echo ""
    echo "On macOS, Claude Code stores credentials in the login Keychain"
    echo "rather than in ~/.claude/.credentials.json, so this file-copy"
    echo "method does not apply there - use the launch-and-paste option above."
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
        echo "  3) Show fallback import instructions"
        echo "  4) Fix credential file permissions to 600"
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
                interactive_login || true
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

# Skip the interactive menu when sourced (so the file's functions can be
# exercised without entering the read-eval loop).
if [ -z "${CLAUDE_AUTH_HELPER_NO_MAIN:-}" ]; then
    main "$@"
fi
