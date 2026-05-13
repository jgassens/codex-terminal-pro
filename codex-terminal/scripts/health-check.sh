#!/bin/bash

# Health check script for Codex Terminal Pro add-on.

set -uo pipefail

errors=0

log_info() {
    if command -v bashio >/dev/null 2>&1; then
        bashio::log.info "$1"
    else
        echo "[INFO] $1"
    fi
}

log_warning() {
    if command -v bashio >/dev/null 2>&1; then
        bashio::log.warning "$1"
    else
        echo "[WARN] $1"
    fi
}

log_error() {
    if command -v bashio >/dev/null 2>&1; then
        bashio::log.error "$1"
    else
        echo "[ERROR] $1"
    fi
}

check_command() {
    local name="$1"
    local required="${2:-true}"

    if command -v "$name" >/dev/null 2>&1; then
        log_info "$name found at: $(command -v "$name")"
        return 0
    fi

    if [ "$required" = "true" ]; then
        log_error "$name not found"
        return 1
    fi

    log_warning "$name not found"
    return 0
}

check_codex() {
    log_info "=== Codex CLI Check ==="

    if ! check_command codex true; then
        return 1
    fi

    if codex --version >/tmp/codex-version.txt 2>/tmp/codex-version.err; then
        log_info "Codex version: $(cat /tmp/codex-version.txt)"
    else
        log_warning "Codex exists but 'codex --version' failed"
        if [ -s /tmp/codex-version.err ]; then
            log_warning "$(head -n 1 /tmp/codex-version.err)"
        fi
    fi
}

check_codex_home() {
    log_info "=== Codex State Check ==="

    local codex_home="${CODEX_HOME:-/data/.codex}"
    local config_file="$codex_home/config.toml"
    local auth_file="$codex_home/auth.json"

    if [ -d "$codex_home" ]; then
        log_info "CODEX_HOME exists: $codex_home"
    else
        log_error "CODEX_HOME missing: $codex_home"
        return 1
    fi

    if [ -f "$config_file" ] && grep -q '^cli_auth_credentials_store[[:space:]]*=[[:space:]]*"file"' "$config_file"; then
        log_info "Codex file credential storage configured"
    else
        log_warning "Codex file credential storage is not configured"
    fi

    if [ -f "$auth_file" ]; then
        local mode
        mode=$(stat -c "%a" "$auth_file" 2>/dev/null || echo "unknown")
        if [ "$mode" = "600" ]; then
            log_info "auth.json exists with 600 permissions"
        else
            log_warning "auth.json exists but permissions are $mode; expected 600"
        fi
    else
        log_warning "auth.json not found. Run codex-auth-helper to log in or import credentials."
    fi
}

check_network() {
    log_info "=== Network Check ==="

    if curl -s --head --connect-timeout 10 --max-time 15 https://api.openai.com >/dev/null; then
        log_info "Can reach OpenAI API endpoint"
    else
        log_warning "Cannot reach OpenAI API endpoint from the add-on"
    fi

    if curl -s --head --connect-timeout 10 --max-time 15 https://github.com >/dev/null; then
        log_info "Can reach GitHub"
    else
        log_warning "Cannot reach GitHub"
    fi
}

check_home_assistant_tools() {
    log_info "=== Home Assistant Utility Check ==="

    check_command ha false || true
    check_command gh false || true
    check_command ttyd true
    check_command node true
    check_command npm true
}

main() {
    log_info "Codex Terminal Pro Health Check"
    log_info "================================"

    check_codex || ((errors++))
    check_codex_home || ((errors++))
    check_home_assistant_tools || ((errors++))
    check_network || true

    if [ "$errors" -gt 0 ]; then
        log_error "Health check completed with $errors error(s)"
        return 1
    fi

    log_info "Health check completed"
}

main "$@"
