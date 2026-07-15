#!/bin/bash

# Health check script for Codex Terminal Pro add-on.

set -uo pipefail

errors=0

log_info() {
    if type bashio::log.info >/dev/null 2>&1; then
        bashio::log.info "$1"
    else
        echo "[INFO] $1"
    fi
    return 0
}

log_warning() {
    if type bashio::log.warning >/dev/null 2>&1; then
        bashio::log.warning "$1"
    else
        echo "[WARN] $1"
    fi
    return 0
}

log_error() {
    if type bashio::log.error >/dev/null 2>&1; then
        bashio::log.error "$1"
    else
        echo "[ERROR] $1"
    fi
    return 0
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

    log_info "Codex CLI path: $(command -v codex)"
    log_info "Codex version check skipped to avoid plugin cache hydration during health checks"
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
    local status=0

    check_command ha false || true
    check_command gh false || true
    check_command ttyd true || status=1
    check_command node true || status=1
    check_command npm true || status=1
    return "$status"
}

check_github_integrations() {
    local github_mcp_guard="/data/packages/guard/bin/codex-terminal-disable-github-mcp"

    log_info "=== GitHub Integration Check ==="

    if command -v gh >/dev/null 2>&1; then
        if gh auth status >/dev/null 2>&1; then
            log_info "GitHub CLI authentication is configured"
        else
            log_warning "GitHub CLI is installed but not authenticated; run gh auth login if CLI access is wanted"
        fi
    fi

    if [ ! -x "$github_mcp_guard" ]; then
        log_warning "GitHub MCP readiness guard is unavailable"
        return 0
    fi

    if "$github_mcp_guard" --check; then
        if [ -n "${GITHUB_PAT_TOKEN:-}" ]; then
            log_info "GitHub MCP PAT is present; transport configuration was left unchanged"
        else
            log_info "No unauthenticated legacy GitHub MCP transport is enabled"
        fi
        return 0
    fi

    log_error "Legacy GitHub MCP transport is enabled without GITHUB_PAT_TOKEN"
    return 1
}

main() {
    log_info "Codex Terminal Pro Health Check"
    log_info "================================"

    check_codex || ((errors++))
    check_codex_home || ((errors++))
    check_home_assistant_tools || ((errors++))
    check_github_integrations || ((errors++))
    check_network || true

    if [ "$errors" -gt 0 ]; then
        log_error "Health check completed with $errors error(s)"
        return 1
    fi

    log_info "Health check completed"
}

main "$@"
