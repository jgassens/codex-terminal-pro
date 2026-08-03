#!/usr/bin/with-contenv bashio

set -e
set -o pipefail

IMAGE_SERVICE_PID=""
TTYD_PID=""
SSH_BRIDGE_PID=""
HA_MONITOR_PID=""

# Initialize environment for Codex CLI using /data, the persistent Home Assistant
# add-on storage volume.
init_environment() {
    local data_home="/data/home"
    local config_dir="/data/.config"
    local cache_dir="/data/.cache"
    local local_dir="/data/.local"
    local state_dir="/data/.local/state"
    local data_dir="/data/.local/share"
    local codex_home="/data/.codex"
    local gh_config_dir="/data/.config/gh"
    local persist_root="/data/packages"
    local guard_root="$persist_root/guard"
    local guard_bin="$guard_root/bin"
    local guard_libexec="$guard_root/libexec"
    local persist_bin="$persist_root/bin"
    local persist_python="$persist_root/python"
    local image_dir="/data/images"
    local log_dir="/data/logs"
    local monitor_dir="/data/monitor"
    local supervisor_dir="/data/.supervisor"

    bashio::log.info "Initializing Codex environment in /data..."

    if ! mkdir -p "$data_home" "$config_dir" "$cache_dir" "$local_dir" "$state_dir" "$data_dir" \
                  "$codex_home" "$gh_config_dir" "$persist_bin" \
                  "$persist_python" "$guard_bin" "$guard_libexec" "$image_dir" "$log_dir" \
                  "$monitor_dir/tasks.d" "$supervisor_dir/confirm"; then
        bashio::log.error "Failed to create directories in /data"
        exit 1
    fi

    chmod 700 "$data_home" "$config_dir" "$cache_dir" "$local_dir" "$state_dir" \
              "$data_dir" "$codex_home" "$gh_config_dir" "$guard_root" "$guard_bin" \
              "$guard_libexec" "$monitor_dir" "$monitor_dir/tasks.d" "$supervisor_dir" "$supervisor_dir/confirm"
    chmod 755 "$persist_root" "$persist_bin" "$persist_python" "$image_dir"
    chmod 700 "$log_dir"

    export HOME="$data_home"
    export XDG_CONFIG_HOME="$config_dir"
    export XDG_CACHE_HOME="$cache_dir"
    export XDG_STATE_HOME="$state_dir"
    export XDG_DATA_HOME="$data_dir"
    export CODEX_HOME="$codex_home"
    export GH_CONFIG_DIR="$gh_config_dir"
    if [ -d "/opt/modbus-python" ]; then
        export PYTHONPATH="/opt/modbus-python:${PYTHONPATH:-}"
    fi

    install_codex_plugin_cache_guard "$guard_bin"
    ensure_codex_file_credentials
    ensure_heygen_codex_plugin_disabled
    ensure_github_codex_mcp_ready
    ensure_codex_security_mcp_ready
    remove_heygen_codex_plugin_state
    ensure_codex_update_prompt_disabled
    ensure_codex_execution_defaults
    ensure_codex_tui_defaults

    if [ -f "$CODEX_HOME/auth.json" ]; then
        chmod 600 "$CODEX_HOME/auth.json"
    fi

    if ! /opt/scripts/persistent-packages.sh migrate; then
        bashio::log.error "Failed to quarantine legacy copied package files"
        exit 1
    fi

    export PATH="$guard_bin:$PATH:$persist_python/venv/bin:$persist_bin"

    if [ -d "$persist_python/venv" ]; then
        export VIRTUAL_ENV="$persist_python/venv"
        bashio::log.info "  - Python venv: active"
    fi

    cat > /etc/profile.d/persistent-packages.sh << 'PROFILE_EOF'
# Persistent Codex Terminal Pro environment - auto-loaded for all bash sessions
export HOME="/data/home"
export XDG_CONFIG_HOME="/data/.config"
export XDG_CACHE_HOME="/data/.cache"
export XDG_STATE_HOME="/data/.local/state"
export XDG_DATA_HOME="/data/.local/share"
export CODEX_HOME="/data/.codex"
export GH_CONFIG_DIR="/data/.config/gh"

if [ -x "/data/packages/guard/bin/codex-terminal-disable-github-mcp" ]; then
    /data/packages/guard/bin/codex-terminal-disable-github-mcp >/dev/null 2>&1 || true
fi

if [ -x "/data/packages/guard/bin/codex-terminal-disable-codex-security-mcp" ]; then
    /data/packages/guard/bin/codex-terminal-disable-codex-security-mcp >/dev/null 2>&1 || true
fi

if [ -x "/data/packages/guard/bin/codex-terminal-prune-codex-plugins" ]; then
    /data/packages/guard/bin/codex-terminal-prune-codex-plugins >/dev/null 2>&1 || true
fi

export PATH="/data/packages/guard/bin:/data/packages/python/venv/bin:$PATH:/data/packages/bin"
if [ -d "/opt/modbus-python" ]; then
    export PYTHONPATH="/opt/modbus-python:${PYTHONPATH:-}"
fi
unset SUPERVISOR_TOKEN

if [ -d "/data/packages/python/venv" ]; then
    export VIRTUAL_ENV="/data/packages/python/venv"
fi
PROFILE_EOF

    chmod 644 /etc/profile.d/persistent-packages.sh
    bashio::log.info "  - Profile script created: /etc/profile.d/persistent-packages.sh"

    bashio::log.info "Environment initialized:"
    bashio::log.info "  - Home: $HOME"
    bashio::log.info "  - XDG config: $XDG_CONFIG_HOME"
    bashio::log.info "  - Codex home: $CODEX_HOME"
    bashio::log.info "  - GitHub config: $GH_CONFIG_DIR"
    bashio::log.info "  - Cache: $XDG_CACHE_HOME"
    bashio::log.info "  - Persistent packages: $persist_root"
}

ensure_codex_file_credentials() {
    local config_file="$CODEX_HOME/config.toml"

    if ! set_codex_top_level_config "$config_file" "cli_auth_credentials_store" '"file"'; then
        bashio::log.warning "Could not set Codex file credential storage; invalid config.toml was left unchanged"
    fi
    return 0
}

ensure_codex_update_prompt_disabled() {
    local config_file="$CODEX_HOME/config.toml"

    if set_codex_top_level_config "$config_file" "check_for_update_on_startup" "false"; then
        bashio::log.info "Codex CLI startup update prompt disabled; update Codex through add-on releases"
    else
        bashio::log.warning "Could not update Codex startup prompt setting; invalid config.toml was left unchanged"
    fi
    return 0
}

ensure_codex_execution_defaults() {
    local config_file="$CODEX_HOME/config.toml"
    local codex_full_access
    codex_full_access=$(bashio::config 'codex_full_access' 'true')

    if [ "$codex_full_access" != "true" ]; then
        bashio::log.info "Codex execution defaults left unmanaged (codex_full_access: false)"
        return 0
    fi

    # The add-on container is the operating boundary: only /config and /data
    # are mapped, ingress is admin-only, and management-capable ha and
    # supervisor-api commands stop at the human-answered broker challenge.
    # Codex CLI's inner sandbox cannot see any of that; it blocks the bundled
    # helpers (Home Assistant API network access, /data state) and stalls
    # sessions on approval reviews with no human in the loop to answer them.
    if set_codex_top_level_config "$config_file" "approval_policy" '"never"' &&
        set_codex_top_level_config "$config_file" "sandbox_mode" '"danger-full-access"'; then
        bashio::log.info "Codex execution defaults set: full container access without approval prompts; the Supervisor broker still guards HA management"
    else
        bashio::log.warning "Could not set Codex execution defaults; invalid config.toml was left unchanged"
    fi
    return 0
}

ensure_heygen_codex_plugin_disabled() {
    local disabler="/data/packages/guard/bin/codex-terminal-disable-heygen-plugin"

    if [ ! -x "$disabler" ]; then
        bashio::log.warning "HeyGen Codex plugin disabler missing: ${disabler}"
        return 0
    fi

    if "$disabler"; then
        bashio::log.info "Disabled irrelevant HeyGen Codex plugin entries in config.toml"
        return 0
    fi

    bashio::log.warning "Failed to disable HeyGen Codex plugin entries in config.toml"
}

ensure_github_codex_mcp_ready() {
    local disabler="/data/packages/guard/bin/codex-terminal-disable-github-mcp"

    if [ ! -x "$disabler" ]; then
        bashio::log.warning "GitHub Codex MCP readiness guard missing: ${disabler}"
        return 0
    fi

    if "$disabler"; then
        if [ -n "${GITHUB_PAT_TOKEN:-}" ]; then
            bashio::log.info "GitHub Codex MCP: PAT is present; transport configuration left unchanged"
        else
            bashio::log.info "GitHub Codex MCP: disabled legacy PAT-backed transport; GitHub plugin and gh CLI preserved"
        fi
        return 0
    fi

    bashio::log.warning "Failed to apply GitHub Codex MCP readiness policy"
}

ensure_codex_security_mcp_ready() {
    local disabler="/data/packages/guard/bin/codex-terminal-disable-codex-security-mcp"

    if [ ! -x "$disabler" ]; then
        bashio::log.warning "Codex Security MCP startup guard missing: ${disabler}"
        return 0
    fi

    if "$disabler"; then
        bashio::log.info "Codex Security plugin: disabled stale-path-prone MCP transport; security skills preserved"
        return 0
    fi

    bashio::log.warning "Failed to disable the failing Codex Security MCP transport"
}

set_codex_top_level_config() {
    local config_file="$1"
    local key="$2"
    local value="$3"
    local setter="${CODEX_CONFIG_SET_BIN:-/opt/scripts/codex-config-set}"

    "$setter" "$config_file" "$key" "$value"
}

ensure_codex_tui_defaults() {
    local config_file="$CODEX_HOME/config.toml"
    local tui_setter="${CODEX_CONFIG_TUI_BIN:-/opt/scripts/codex-config-tui}"

    if "$tui_setter" "$config_file"; then
        bashio::log.info "Codex TUI defaults verified; supported user status items preserved"
    else
        bashio::log.warning "Could not update Codex TUI defaults; invalid config.toml was left unchanged"
    fi
    return 0
}

install_codex_plugin_cache_guard() {
    local guard_bin="$1"
    local pruner="${guard_bin}/codex-terminal-prune-codex-plugins"
    local heygen_disabler="${guard_bin}/codex-terminal-disable-heygen-plugin"
    local github_mcp_disabler="${guard_bin}/codex-terminal-disable-github-mcp"
    local codex_security_mcp_disabler="${guard_bin}/codex-terminal-disable-codex-security-mcp"
    local wrapper="${guard_bin}/codex"

    if [ -f "/opt/scripts/codex_config_utils.py" ]; then
        cp /opt/scripts/codex_config_utils.py "${guard_bin}/codex_config_utils.py"
        chmod 644 "${guard_bin}/codex_config_utils.py"
    else
        bashio::log.warning "Codex config lock helper missing: /opt/scripts/codex_config_utils.py"
    fi

    if [ -f "/opt/scripts/codex-prune-plugins" ]; then
        cp /opt/scripts/codex-prune-plugins "$pruner"
        chmod 755 "$pruner"
    else
        bashio::log.warning "Codex plugin pruner missing: /opt/scripts/codex-prune-plugins"
    fi

    if [ -f "/opt/scripts/codex-disable-heygen-plugin" ]; then
        cp /opt/scripts/codex-disable-heygen-plugin "$heygen_disabler"
        chmod 755 "$heygen_disabler"
    else
        bashio::log.warning "Codex HeyGen plugin disabler missing: /opt/scripts/codex-disable-heygen-plugin"
    fi

    if [ -f "/opt/scripts/codex-disable-github-mcp" ]; then
        cp /opt/scripts/codex-disable-github-mcp "$github_mcp_disabler"
        chmod 755 "$github_mcp_disabler"
    else
        bashio::log.warning "Codex GitHub MCP disabler missing: /opt/scripts/codex-disable-github-mcp"
    fi

    if [ -f "/opt/scripts/codex-disable-codex-security-mcp" ]; then
        cp /opt/scripts/codex-disable-codex-security-mcp "$codex_security_mcp_disabler"
        chmod 755 "$codex_security_mcp_disabler"
    else
        bashio::log.warning "Codex Security MCP disabler missing: /opt/scripts/codex-disable-codex-security-mcp"
    fi

    cat > "$wrapper" << 'CODEX_GUARD_EOF'
#!/usr/bin/env bash

set -uo pipefail

if [ -x "/data/packages/guard/bin/codex-terminal-disable-heygen-plugin" ]; then
    /data/packages/guard/bin/codex-terminal-disable-heygen-plugin >/dev/null 2>&1 || true
fi

if [ -x "/data/packages/guard/bin/codex-terminal-disable-github-mcp" ]; then
    /data/packages/guard/bin/codex-terminal-disable-github-mcp >/dev/null 2>&1 || true
fi

if [ -x "/data/packages/guard/bin/codex-terminal-disable-codex-security-mcp" ]; then
    /data/packages/guard/bin/codex-terminal-disable-codex-security-mcp >/dev/null 2>&1 || true
fi

if [ -x "/data/packages/guard/bin/codex-terminal-prune-codex-plugins" ]; then
    /data/packages/guard/bin/codex-terminal-prune-codex-plugins >/dev/null 2>&1 || true
fi

self="$(readlink -f "$0" 2>/dev/null || printf '%s\n' "$0")"

for candidate in /usr/local/bin/codex /usr/bin/codex; do
    if [ ! -x "$candidate" ]; then
        continue
    fi

    resolved="$(readlink -f "$candidate" 2>/dev/null || printf '%s\n' "$candidate")"
    if [ "$resolved" = "$self" ]; then
        continue
    fi

    exec "$candidate" "$@"
done

printf 'Codex Terminal Pro: real codex executable not found.\n' >&2
exit 127
CODEX_GUARD_EOF

    chmod 755 "$wrapper"
    bashio::log.info "Codex plugin cache guard installed at ${wrapper}"
}

remove_heygen_codex_plugin_state() {
    local pruner="/data/packages/guard/bin/codex-terminal-prune-codex-plugins"

    if [ ! -x "$pruner" ]; then
        return 0
    fi

    if "$pruner"; then
        bashio::log.info "Pruned irrelevant HeyGen Codex plugin cache and source copies"
        return 0
    fi

    bashio::log.warning "Failed to fully prune HeyGen Codex plugin state"
}

install_tools() {
    local missing=()

    command -v ttyd >/dev/null 2>&1 || missing+=("ttyd")
    command -v tmux >/dev/null 2>&1 || missing+=("tmux")
    command -v bwrap >/dev/null 2>&1 || missing+=("bubblewrap")
    command -v rg >/dev/null 2>&1 || missing+=("ripgrep")
    command -v ncat >/dev/null 2>&1 || missing+=("nmap-ncat")
    command -v socat >/dev/null 2>&1 || missing+=("socat")
    command -v tcpdump >/dev/null 2>&1 || missing+=("tcpdump")
    apk info -e libmodbus >/dev/null 2>&1 || missing+=("libmodbus")
    command -v jq >/dev/null 2>&1 || missing+=("jq")
    command -v yq >/dev/null 2>&1 || missing+=("yq")
    command -v sqlite3 >/dev/null 2>&1 || missing+=("sqlite")
    command -v mosquitto_sub >/dev/null 2>&1 || missing+=("mosquitto-clients")
    command -v dig >/dev/null 2>&1 || missing+=("bind-tools")
    command -v ping >/dev/null 2>&1 || missing+=("iputils")
    command -v openssl >/dev/null 2>&1 || missing+=("openssl")
    command -v ssh >/dev/null 2>&1 || missing+=("openssh-client")
    command -v rsync >/dev/null 2>&1 || missing+=("rsync")
    command -v curl >/dev/null 2>&1 || missing+=("curl")

    if [ "${#missing[@]}" -gt 0 ]; then
        bashio::log.info "Installing missing runtime tools: ${missing[*]}"
        if ! apk add --no-cache "${missing[@]}"; then
            bashio::log.error "Failed to install required runtime tools: ${missing[*]}"
            exit 1
        fi
    fi
}

log_startup_diagnostics() {
    local app_name="${APP_NAME:-${ADDON_NAME:-Codex Terminal Pro}}"
    local app_version="${BUILD_VERSION:-${APP_VERSION:-2.6.7}}"

    bashio::log.info "Startup diagnostics:"
    bashio::log.info "  - Date: $(date)"
    bashio::log.info "  - App: ${app_name} ${app_version}"
    bashio::log.info "  - Machine: $(uname -m)"
    bashio::log.info "  - HOME: ${HOME}"
    bashio::log.info "  - CODEX_HOME: ${CODEX_HOME}"
    bashio::log.info "  - PATH: ${PATH}"
    bashio::log.info "  - which ttyd: $(which ttyd 2>/dev/null || true)"
    bashio::log.info "  - which tmux: $(which tmux 2>/dev/null || true)"
    bashio::log.info "  - tmux version: $(tmux -V 2>/dev/null || true)"
    bashio::log.info "  - which bwrap: $(which bwrap 2>/dev/null || true)"
    bashio::log.info "  - bwrap version: $(bwrap --version 2>&1 || true)"
    bashio::log.info "  - which rg: $(which rg 2>/dev/null || true)"
    bashio::log.info "  - rg version: $(rg --version 2>&1 | head -1 || true)"
    bashio::log.info "  - which ncat: $(which ncat 2>/dev/null || true)"
    bashio::log.info "  - which socat: $(which socat 2>/dev/null || true)"
    bashio::log.info "  - which tcpdump: $(which tcpdump 2>/dev/null || true)"
    bashio::log.info "  - which modbus-read: $(which modbus-read 2>/dev/null || true)"
    bashio::log.info "  - modbus-read version: $(modbus-read --version 2>&1 || true)"
    bashio::log.info "  - which ha-toolbox: $(which ha-toolbox 2>/dev/null || true)"
    bashio::log.info "  - ha-toolbox version: $(ha-toolbox --version 2>&1 || true)"
    bashio::log.info "  - which ha-api: $(which ha-api 2>/dev/null || true)"
    bashio::log.info "  - ha-api version: $(ha-api --version 2>&1 || true)"
    bashio::log.info "  - which ha-ws: $(which ha-ws 2>/dev/null || true)"
    bashio::log.info "  - ha-ws version: $(ha-ws --version 2>&1 || true)"
    bashio::log.info "  - which ha-mcp-status: $(which ha-mcp-status 2>/dev/null || true)"
    bashio::log.info "  - ha-mcp-status version: $(ha-mcp-status --version 2>&1 || true)"
    bashio::log.info "  - which ha-monitor: $(which ha-monitor 2>/dev/null || true)"
    bashio::log.info "  - ha-monitor version: $(ha-monitor --version 2>&1 || true)"
    bashio::log.info "  - which ha-site-memory: $(which ha-site-memory 2>/dev/null || true)"
    bashio::log.info "  - ha-site-memory version: $(ha-site-memory --version 2>&1 || true)"
    bashio::log.info "  - which sqlite3: $(which sqlite3 2>/dev/null || true)"
    bashio::log.info "  - which mosquitto_sub: $(which mosquitto_sub 2>/dev/null || true)"
    bashio::log.info "  - which dig: $(which dig 2>/dev/null || true)"
    bashio::log.info "  - which codex: $(which codex 2>/dev/null || true)"
    bashio::log.info "  - codex version: skipped during startup to avoid plugin cache hydration"
    bashio::log.info "  - which ha: $(which ha 2>/dev/null || true)"
}

setup_modbus_tools() {
    local tool

    for tool in modbus-read modbus-scan modbus-toolbox; do
        if [ -f "/opt/scripts/${tool}" ]; then
            cp "/opt/scripts/${tool}" "/usr/local/bin/${tool}"
            chmod 755 "/usr/local/bin/${tool}"
        else
            bashio::log.warning "Modbus helper missing: /opt/scripts/${tool}"
        fi
    done

    bashio::log.info "Modbus toolbox installed: modbus-toolbox, modbus-scan, modbus-read"
}

setup_ha_tools() {
    local tool

    for tool in ha-toolbox ha-api ha-ws ha-mcp-status ha-monitor ha-site-memory; do
        if [ -f "/opt/scripts/${tool}" ]; then
            cp "/opt/scripts/${tool}" "/usr/local/bin/${tool}"
            chmod 755 "/usr/local/bin/${tool}"
        else
            bashio::log.warning "Home Assistant helper missing: /opt/scripts/${tool}"
        fi
    done

    bashio::log.info "Home Assistant helpers installed: ha-toolbox, ha-api, ha-ws, ha-mcp-status, ha-monitor, ha-site-memory"
}

refresh_ha_site_memory_once() {
    local memory_bin="/usr/local/bin/ha-site-memory"

    if [ ! -x "${memory_bin}" ]; then
        bashio::log.warning "HA site memory helper is not available at ${memory_bin}"
        return 0
    fi

    mkdir -p /data/monitor
    chmod 700 /data/monitor

    bashio::log.info "Refreshing Home Assistant site memory..."
    if "${memory_bin}" refresh --quiet; then
        bashio::log.info "HA site memory written to /data/monitor/ha-site-memory.md"
    else
        bashio::log.warning "HA site memory refresh failed; keeping any previous memory file"
    fi
}

setup_session_picker() {
    if [ -f "/opt/scripts/codex-session-picker.sh" ]; then
        if ! cp /opt/scripts/codex-session-picker.sh /usr/local/bin/codex-session-picker; then
            bashio::log.error "Failed to install codex-session-picker"
            exit 1
        fi
        chmod +x /usr/local/bin/codex-session-picker
        bashio::log.info "Session picker installed: codex-session-picker"
    else
        bashio::log.warning "Session picker script not found, using auto-launch mode only"
    fi

    if [ -f "/opt/scripts/codex-auth-helper.sh" ]; then
        if ! cp /opt/scripts/codex-auth-helper.sh /usr/local/bin/codex-auth-helper; then
            bashio::log.error "Failed to install codex-auth-helper"
            exit 1
        fi
        chmod +x /usr/local/bin/codex-auth-helper
        bashio::log.info "Authentication helper installed: codex-auth-helper"
    fi
}

setup_shell_dispatch_profile() {
    if [ -f "/opt/scripts/codex-terminal-shell-dispatch.sh" ]; then
        cp /opt/scripts/codex-terminal-shell-dispatch.sh /etc/profile.d/codex-terminal-shell-dispatch.sh
        chmod 644 /etc/profile.d/codex-terminal-shell-dispatch.sh
        bashio::log.info "Shell dispatch profile installed for raw Shell mode"
    else
        bashio::log.warning "Shell dispatch profile missing: /opt/scripts/codex-terminal-shell-dispatch.sh"
    fi
}

managed_config_path() {
    local config_root="${CODEX_TERMINAL_CONFIG_ROOT:-/config}"
    local name="$1"

    printf '%s/%s\n' "${config_root%/}" "$name"
}

safe_publish_config_file() {
    local source="$1"
    local name="$2"
    local mode="$3"
    local helper="${CODEX_TERMINAL_CONFIG_FILE_HELPER:-/opt/scripts/codex-terminal-config-files.py}"

    "$helper" publish "$source" "$name" "$mode"
}

safe_snapshot_config_file() {
    local name="$1"
    local destination="$2"
    local helper="${CODEX_TERMINAL_CONFIG_FILE_HELPER:-/opt/scripts/codex-terminal-config-files.py}"

    "$helper" snapshot "$name" "$destination"
}

setup_host_ssh_attach_helper() {
    local source="/opt/scripts/codex-terminal-host-attach.sh"
    local target_name="codex-terminal-pro-attach"
    local target

    target="$(managed_config_path "$target_name")"

    if [ -f "${source}" ]; then
        if safe_publish_config_file "$source" "$target_name" "0755"; then
            bashio::log.info "Home Assistant SSH attach helper written to ${target}"
        else
            bashio::log.warning "Could not write Home Assistant SSH attach helper to ${target}"
        fi
    else
        bashio::log.warning "Home Assistant SSH attach helper missing: ${source}"
    fi
}

setup_persistent_packages() {
    if [ -f "/opt/scripts/persist-install" ]; then
        cp /opt/scripts/persist-install /usr/local/bin/persist-install
        chmod +x /usr/local/bin/persist-install
        bashio::log.info "Persistent package manager installed: persist-install"
    fi

    restore_persisted_apk_packages
    restore_persisted_python_packages
    if ! auto_install_packages; then
        bashio::log.warning "Some configured persistent packages could not be installed"
    fi
}

restore_persisted_apk_packages() {
    if ! /opt/scripts/persistent-packages.sh restore; then
        bashio::log.warning "Some persisted APK packages could not be restored; all manifest entries were attempted"
    fi
}

restore_persisted_python_packages() {
    if ! /opt/scripts/persistent-packages.sh restore-pip; then
        bashio::log.warning "Persisted Python requirements could not be restored for the current interpreter"
    fi
}

is_safe_package_name() {
    case "$1" in
        ''|-*|*[!A-Za-z0-9@._:+!=\>\<,\[\]~-]*)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

auto_install_packages() {
    local apk_packages
    local pip_packages
    local pkg
    local status=0
    local persist_install_bin="${PERSIST_INSTALL_BIN:-/usr/local/bin/persist-install}"
    local apk_args=()
    local pip_args=()

    if ! apk_packages="$(bashio::config 'persistent_apk_packages' '')"; then
        bashio::log.error "Could not read persistent_apk_packages configuration"
        return 1
    fi
    if ! pip_packages="$(bashio::config 'persistent_pip_packages' '')"; then
        bashio::log.error "Could not read persistent_pip_packages configuration"
        return 1
    fi

    # bashio emits array values one per line; it does not return JSON here.
    if [ -n "$apk_packages" ]; then
        bashio::log.info "Auto-installing system packages from config..."
        while IFS= read -r pkg; do
            [ -n "$pkg" ] || continue
            if ! is_safe_package_name "$pkg"; then
                bashio::log.warning "Rejected invalid system package name: $pkg"
                status=1
                continue
            fi
            apk_args+=("$pkg")
        done <<< "$apk_packages"

        if [ "${#apk_args[@]}" -gt 0 ]; then
            bashio::log.info "  Installing: ${apk_args[*]}"
            "$persist_install_bin" "${apk_args[@]}" || status=$?
        fi
    fi

    if [ -n "$pip_packages" ]; then
        bashio::log.info "Auto-installing Python packages from config..."
        while IFS= read -r pkg; do
            [ -n "$pkg" ] || continue
            if ! is_safe_package_name "$pkg"; then
                bashio::log.warning "Rejected invalid Python package name: $pkg"
                status=1
                continue
            fi
            pip_args+=("$pkg")
        done <<< "$pip_packages"

        if [ "${#pip_args[@]}" -gt 0 ]; then
            bashio::log.info "  Installing: ${pip_args[*]}"
            "$persist_install_bin" --python "${pip_args[@]}" || status=$?
        fi
    fi

    return "$status"
}

write_codex_terminal_agents_block() {
    local target_name="$1"
    local fallback_source="$2"
    local input_file
    local output_file
    local snapshot_status=0

    input_file="$(mktemp)"
    output_file="$(mktemp)"
    if safe_snapshot_config_file "$target_name" "$input_file"; then
        :
    else
        snapshot_status=$?
        if [ "$snapshot_status" -ne 3 ]; then
            bashio::log.warning "Unsafe or unreadable $(managed_config_path "$target_name") was not followed; replacing it with managed guidance"
        fi
        if ! cp "$fallback_source" "$input_file"; then
            rm -f "$input_file" "$output_file"
            return 1
        fi
    fi

    awk '
        /^<!-- BEGIN CODEX TERMINAL PRO MANAGED GUIDANCE -->$/ { skip = 1; next }
        /^<!-- END CODEX TERMINAL PRO MANAGED GUIDANCE -->$/ { skip = 0; next }
        !skip { print }
    ' "$input_file" > "$output_file"

    cat >> "$output_file" <<'AGENTS_BLOCK'

<!-- BEGIN CODEX TERMINAL PRO MANAGED GUIDANCE -->
## Codex Terminal Pro Capabilities

- You are running inside Codex Terminal Pro for Home Assistant.
- Work from `/config` unless the human explicitly asks otherwise.
- If you are unsure what tools or behaviors this add-on provides, run
  `codex-terminal-briefing` or read `/config/CODEX_TERMINAL_PRO.md` before
  guessing.
- Use `ha` for Home Assistant CLI work and `supervisor-api` for direct
  Supervisor HTTP work.
- Use `ha-toolbox`, `ha-toolbox audit-config --config /config`,
  `ha-toolbox states`, and `ha-toolbox services` for read-only Home Assistant
  orientation before broad changes.
- Use `ha-api` for exact read-only Home Assistant REST lookups such as one
  entity state, service schemas, events, and MCP status.
- Use `ha-ws` for read-only Home Assistant WebSocket discovery: entity
  registry display, target expansion, service capability checks, exposed
  entities, and automation trigger/condition/action validation.
- Use `ha-mcp-status` to check whether Home Assistant's official MCP Server
  integration is loaded before configuring MCP clients.
- Use `ha-monitor status` to read the add-on's bounded observer summary before
  broad Home Assistant triage. It records logs, unavailable state samples, and
  MCP status under `/data/monitor`, but it does not reload, restart, edit files,
  run bespoke task manifests, or call an LLM by itself.
- Use `/data/monitor/change-desk-dispatch.json` as the prepared Change Desk
  packet when present. It contains deterministic deltas, triage labels, and
  reasoning budget gates; high reasoning should happen only from explicit human
  action such as Change Desk's Ask Mall Cop button.
- From a Home Assistant SSH shell with `/config` access, run
  `/config/codex-terminal-pro-attach`. In the ordinary Home Assistant SSH
  add-on, only `status` works through the read-limited `/config` mailbox without
  Docker access. `attach`, `shell`, `send`, `capture`, `transcript`, `logs`, and
  `container` need Docker or the Home Assistant OS host shell. `ask-file` is
  disabled because shared `/config` paths can change before an asynchronous
  Codex write.
- Treat monitor findings labeled localized connectivity noise as device,
  Modbus, Wi-Fi, socket, or reachability trouble first, not proof of broken
  Home Assistant configuration. Confirm whether the entity is safety, security,
  or otherwise critical before dismissing it as benign noise.
- Use `ha-site-memory status` or read `/data/monitor/ha-site-memory.md` before
  troubleshooting named rooms, integrations, or house-specific devices such as
  "Ring lights". Treat it as a map of likely entities, then refresh and verify
  exact live state with `ha-api` or `ha-ws` before changing anything. Optional
  human-maintained aliases or recurring fixes may live in `/config/HA_SITE_NOTES.md`.
- `,,` is a Codex Terminal Pro shell-dispatch prefix. If the human prompt starts
  with `,,`, strip that prefix and run the rest through `codex-shell-dispatch`.
  Do not run the stripped command directly through Codex's normal shell path.
- Example: `,,ha store reload` becomes `codex-shell-dispatch ha store reload`.
- Example: `,, supervisor-api -X POST /core/api/services/automation/reload`
  becomes
  `codex-shell-dispatch supervisor-api -X POST /core/api/services/automation/reload`.
- Do not ask for another confirmation before using `codex-shell-dispatch` for a
  `,,` prompt; the prefix is the human's direct shell-dispatch instruction.
- Shell mode and `,,` select the interactive command surface; they do not
  bypass the broker. Read-only work runs directly, while management operations
  show a challenge that only the human should answer.
- Use `/opt/home-assistant/HA.md` as the local Home Assistant field guide.
- Search current official Home Assistant documentation or inspect live service
  schemas when integration behavior, service payloads, or Supervisor behavior
  could have changed.
- Use `solar-toolbox`, `solar-toolbox audit-ha --config /config`, and
  `solar-toolbox snapshot-plan` for solar, battery, inverter, meter, and Home
  Assistant Energy work.
- Use `modbus-toolbox`, `modbus-scan`, and `modbus-read` for read-only Modbus
  discovery. Do not write inverter, battery, relay, export-control, or grid
  support settings unless the human explicitly asks and the exact vendor
  register/API is verified.
<!-- END CODEX TERMINAL PRO MANAGED GUIDANCE -->
AGENTS_BLOCK

    if ! safe_publish_config_file "$output_file" "$target_name" "0644"; then
        rm -f "$input_file" "$output_file"
        return 1
    fi
    rm -f "$input_file" "$output_file"
}

setup_supervisor_broker() {
    local guard_dir="/data/packages/guard/bin"
    local supervisor_dir="/data/.supervisor"
    local broker_enabled
    local broker_ttl
    local target_agents_name="AGENTS.md"
    local fallback_agents_name="AGENTS.codex-terminal-pro.md"
    local briefing_name="CODEX_TERMINAL_PRO.md"
    local target_agents
    local fallback_agents
    local briefing_file
    local briefing_tmp

    target_agents="$(managed_config_path "$target_agents_name")"
    fallback_agents="$(managed_config_path "$fallback_agents_name")"
    briefing_file="$(managed_config_path "$briefing_name")"

    broker_enabled=$(bashio::config 'supervisor_broker_enabled' 'true')
    broker_ttl=$(normalize_nonnegative_int "$(bashio::config 'supervisor_broker_t1_ttl_seconds' '120')" "120")

    mkdir -p "$guard_dir" "$supervisor_dir/confirm" "/data/logs"
    chmod 700 "/data/packages/guard" "$guard_dir" "$supervisor_dir" "$supervisor_dir/confirm" "/data/logs"

    if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
        printf '%s\n' "$SUPERVISOR_TOKEN" > "$supervisor_dir/token"
        chmod 600 "$supervisor_dir/token"
    elif [ ! -s "$supervisor_dir/token" ]; then
        bashio::log.warning "SUPERVISOR_TOKEN is not available; brokered ha commands may fail"
    fi

    cat > "$supervisor_dir/broker.conf" << BROKER_CONF
SUPERVISOR_BROKER_ENABLED="${broker_enabled}"
SUPERVISOR_BROKER_T1_TTL_SECONDS="${broker_ttl}"
BROKER_CONF
    chmod 600 "$supervisor_dir/broker.conf"

    if [ -f /opt/scripts/supervisor-broker.sh ]; then
        cp /opt/scripts/supervisor-broker.sh "$guard_dir/supervisor-broker"
        chmod 755 "$guard_dir/supervisor-broker"
    fi

    if [ -f /opt/scripts/ha-guard.sh ]; then
        cp /opt/scripts/ha-guard.sh "$guard_dir/ha"
        chmod 755 "$guard_dir/ha"
    fi

    if [ -f /opt/scripts/supervisor-api.sh ]; then
        cp /opt/scripts/supervisor-api.sh "$guard_dir/supervisor-api"
        chmod 755 "$guard_dir/supervisor-api"
    fi

    refresh_ha_site_memory_once

    if [ -f /opt/scripts/codex-terminal-briefing ]; then
        cp /opt/scripts/codex-terminal-briefing /usr/local/bin/codex-terminal-briefing
        chmod 755 /usr/local/bin/codex-terminal-briefing
        briefing_tmp="$(mktemp)"
        if ! /usr/local/bin/codex-terminal-briefing > "$briefing_tmp"; then
            rm -f "$briefing_tmp"
            bashio::log.error "Could not generate Codex Terminal Pro briefing"
            return 1
        fi
        if ! safe_publish_config_file "$briefing_tmp" "$briefing_name" "0644"; then
            rm -f "$briefing_tmp"
            bashio::log.error "Could not safely write Codex Terminal Pro briefing to $briefing_file"
            return 1
        fi
        rm -f "$briefing_tmp"
        bashio::log.info "Codex Terminal Pro briefing written to $briefing_file"
    fi

    if [ -f /opt/scripts/codex-terminal-agents.md ]; then
        if ! safe_publish_config_file /opt/scripts/codex-terminal-agents.md "$fallback_agents_name" "0644"; then
            bashio::log.error "Could not safely write fallback agent guidance to $fallback_agents"
            return 1
        fi
        write_codex_terminal_agents_block "$target_agents_name" /opt/scripts/codex-terminal-agents.md
        bashio::log.info "Existing regular /config/AGENTS.md content was preserved when safe; managed guidance is installed at $target_agents and $fallback_agents"
    fi

    unset SUPERVISOR_TOKEN
    bashio::log.info "Supervisor broker: enabled=${broker_enabled}, T1 TTL=${broker_ttl}s"
}

get_codex_launch_command() {
    local auto_launch_codex
    auto_launch_codex=$(bashio::config 'auto_launch_codex' 'true')

    if [ "$auto_launch_codex" = "true" ]; then
        if [ -f /usr/local/bin/codex-session-picker ]; then
            echo "cd /config && clear && echo 'Welcome to Codex Terminal Pro' && echo 'Briefing: /config/CODEX_TERMINAL_PRO.md or codex-terminal-briefing' && echo '' && echo 'Starting Codex in /config...' && sleep 1 && codex; /usr/local/bin/codex-session-picker"
        else
            echo "cd /config && clear && echo 'Welcome to Codex Terminal Pro' && echo 'Briefing: /config/CODEX_TERMINAL_PRO.md or codex-terminal-briefing' && echo '' && echo 'Starting Codex in /config...' && sleep 1 && codex"
        fi
    else
        if [ -f /usr/local/bin/codex-session-picker ]; then
            echo "cd /config && clear && /usr/local/bin/codex-session-picker"
        else
            bashio::log.warning "Session picker not found, falling back to Codex auto-launch"
            echo "cd /config && clear && echo 'Welcome to Codex Terminal Pro' && echo 'Briefing: /config/CODEX_TERMINAL_PRO.md or codex-terminal-briefing' && echo '' && echo 'Starting Codex in /config...' && sleep 1 && codex"
        fi
    fi
}

write_tmux_config() {
    local tmux_config="$1"
    local history_limit="$2"

    cat > "${tmux_config}" << TMUX_EOF
set -g mouse on
set -g history-limit ${history_limit}
set -g status off
set -g escape-time 10
# When several devices are attached, size the shared window to the client that
# most recently interacted rather than shrinking it to the smallest screen.
# The web UI releases backgrounded clients so the device in use stays this one.
set -g window-size latest
setw -g mode-keys vi
set -s set-clipboard external
set -as terminal-features ',xterm-256color:clipboard'
set -as terminal-overrides ',xterm-256color:Ms=\E]52;%p1%s;%p2%s\007'
bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel
bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi y send-keys -X copy-selection-and-cancel
bind-key -T copy-mode y send-keys -X copy-selection-and-cancel
TMUX_EOF

    chmod 600 "${tmux_config}"
}

normalize_nonnegative_int() {
    local value="$1"
    local fallback="$2"

    case "$value" in
        ''|*[!0-9]*)
            echo "$fallback"
            ;;
        *)
            echo "$value"
            ;;
    esac
}

write_tmux_launch_script() {
    local launcher="$1"
    local launch_command="$2"

    cat > "${launcher}" << LAUNCH_EOF
#!/usr/bin/env bash

if [ -f /etc/profile.d/persistent-packages.sh ]; then
    . /etc/profile.d/persistent-packages.sh
fi

export HOME="${HOME}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME}"
export XDG_STATE_HOME="${XDG_STATE_HOME}"
export XDG_DATA_HOME="${XDG_DATA_HOME}"
export CODEX_HOME="${CODEX_HOME}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR}"
export PYTHONPATH="${PYTHONPATH:-}"
export TMUX_SESSION="${TMUX_SESSION}"
export TMUX_TARGET="${TMUX_TARGET}"
export CODEX_TMUX_TARGET="${CODEX_TMUX_TARGET}"
unset SUPERVISOR_TOKEN

${launch_command}
LAUNCH_EOF

    chmod 700 "${launcher}"
}

write_transcript_writer() {
    local writer="$1"
    local transcript="$2"
    local max_bytes="$3"
    local backups="$4"

    cat > "${writer}" << WRITER_EOF
#!/usr/bin/env bash
set -uo pipefail

transcript="${transcript}"
max_bytes="${max_bytes}"
backups="${backups}"

mkdir -p "\$(dirname "\${transcript}")"
touch "\${transcript}"
chmod 600 "\${transcript}"
initial_size=\$(stat -c "%s" "\${transcript}" 2>/dev/null || echo 0)

awk -v transcript="\${transcript}" \\
    -v max_bytes="\${max_bytes}" \\
    -v backups="\${backups}" \\
    -v size="\${initial_size}" '
function rotate_transcript(    i) {
    if (max_bytes <= 0) {
        return
    }

    close(transcript)

    if (backups <= 0) {
        system(": > " transcript)
        system("chmod 600 " transcript)
        size = 0
        return
    }

    for (i = backups - 1; i >= 1; i -= 1) {
        system("[ -f " transcript "." i " ] && mv -f " transcript "." i " " transcript "." (i + 1))
    }

    system("[ -f " transcript " ] && mv -f " transcript " " transcript ".1")
    system(": > " transcript)
    system("chmod 600 " transcript)
    size = 0
}

function redact(line) {
    gsub(/Bearer[[:space:]]+[A-Za-z0-9._~+\\/=:-]+/, "Bearer [REDACTED]", line)
    gsub(/sk-[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]+/, "sk-[REDACTED]", line)
    gsub(/SUPERVISOR_TOKEN=[^[:space:]]+/, "SUPERVISOR_TOKEN=[REDACTED]", line)
    gsub(/GITHUB_PAT_TOKEN=[^[:space:]]+/, "GITHUB_PAT_TOKEN=[REDACTED]", line)
    gsub(/gh[pousr]_[A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_]+/, "github_[REDACTED]", line)
    gsub(/github_pat_[A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_][A-Za-z0-9_]+/, "github_pat_[REDACTED]", line)
    gsub(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/, "[JWT REDACTED]", line)
    return line
}

{
    line = redact(\$0)
    line_bytes = length(line) + 1
    if (max_bytes > 0 && size > 0 && size + line_bytes > max_bytes) {
        rotate_transcript()
    }
    print line >> transcript
    size += line_bytes
}
'
WRITER_EOF

    chmod 700 "${writer}"
}

prepare_tmux_session() {
    local session="$1"
    local launcher="$2"
    local tmux_config="$3"
    local transcript="$4"
    local transcript_enabled="$5"
    local transcript_max_bytes="$6"
    local transcript_backups="$7"
    local history_limit="$8"
    local transcript_writer="/tmp/codex-terminal-transcript-writer.sh"

    if ! tmux -f "${tmux_config}" has-session -t "${session}" 2>/dev/null; then
        bashio::log.info "Creating tmux session '${session}'"
        tmux -f "${tmux_config}" new-session -d -s "${session}" "${launcher}"
    else
        bashio::log.info "Reusing existing tmux session '${session}'"
    fi

    tmux -f "${tmux_config}" set-option -g mouse on
    tmux -f "${tmux_config}" set-option -g history-limit "${history_limit}"
    tmux -f "${tmux_config}" set-option -sq set-clipboard external || \
        bashio::log.warning "Could not enable tmux clipboard support"

    if [ "${transcript_enabled}" = "true" ]; then
        write_transcript_writer "${transcript_writer}" "${transcript}" "${transcript_max_bytes}" "${transcript_backups}"
        tmux -f "${tmux_config}" pipe-pane -t "${session}:0.0" -o "${transcript_writer}" || \
            bashio::log.warning "Could not enable terminal transcript logging"
        bashio::log.info "Terminal transcript: ${transcript} (max ${transcript_max_bytes} bytes, ${transcript_backups} backups)"
    else
        tmux -f "${tmux_config}" pipe-pane -t "${session}:0.0" || true
        bashio::log.info "Terminal transcript logging disabled"
    fi
}

start_image_service() {
    local image_port=7680
    local ttyd_port=7681
    local upload_dir="/data/images"
    local service_dir="/opt/image-service"
    local server_file="${service_dir}/server.js"
    local image_retention_days
    local image_retention_max_bytes
    local image_service_ready="false"
    local i

    bashio::log.info "Starting image upload service on port ${image_port}..."

    mkdir -p "${upload_dir}"
    chmod 755 "${upload_dir}"

    export IMAGE_SERVICE_PORT="${image_port}"
    export TTYD_PORT="${ttyd_port}"
    export UPLOAD_DIR="${upload_dir}"
    image_retention_days=$(bashio::config 'image_retention_days' '30')
    image_retention_max_bytes=$(bashio::config 'image_retention_max_bytes' '268435456')
    IMAGE_RETENTION_DAYS=$(normalize_nonnegative_int "${image_retention_days}" "30")
    IMAGE_RETENTION_MAX_BYTES=$(normalize_nonnegative_int "${image_retention_max_bytes}" "268435456")
    export IMAGE_RETENTION_DAYS
    export IMAGE_RETENTION_MAX_BYTES

    if [ ! -f "${server_file}" ]; then
        bashio::log.error "server.js not found at ${server_file}"
        ls -la "${service_dir}"
        return 1
    fi

    if [ ! -d "${service_dir}/node_modules" ]; then
        bashio::log.error "node_modules not found in ${service_dir}"
        bashio::log.error "Image service dependencies must be installed during the Docker build"
        return 1
    fi

    node "${server_file}" > >(
        while IFS= read -r line; do
            bashio::log.info "[Image Service] $line"
        done
    ) 2>&1 &

    IMAGE_SERVICE_PID=$!
    bashio::log.info "Image service started (PID: ${IMAGE_SERVICE_PID})"

    for i in $(seq 1 20); do
        if curl -fsS "http://127.0.0.1:${image_port}/health" >/dev/null 2>&1; then
            image_service_ready="true"
            break
        fi

        if ! kill -0 "${IMAGE_SERVICE_PID}" 2>/dev/null; then
            break
        fi

        sleep 0.1
    done

    if [ "${image_service_ready}" = "true" ]; then
        bashio::log.info "Image service is running successfully"
    else
        bashio::log.error "Image service failed to start"
        return 1
    fi
}

stop_web_processes() {
    local signal="${1:-TERM}"
    local pid

    for pid in "${TTYD_PID:-}" "${IMAGE_SERVICE_PID:-}" "${SSH_BRIDGE_PID:-}" "${HA_MONITOR_PID:-}"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "-${signal}" "$pid" 2>/dev/null || true
        fi
    done
}

supervise_web_processes() {
    local wait_status=0
    local exit_status=0
    local shutting_down="false"
    local supervised_pids=("$IMAGE_SERVICE_PID" "$TTYD_PID")

    if [ -n "${SSH_BRIDGE_PID:-}" ]; then
        supervised_pids+=("$SSH_BRIDGE_PID")
    fi
    if [ -n "${HA_MONITOR_PID:-}" ]; then
        supervised_pids+=("$HA_MONITOR_PID")
    fi

    trap 'shutting_down="true"; stop_web_processes TERM' TERM INT

    wait -n "${supervised_pids[@]}" || wait_status=$?

    if [ "$shutting_down" = "true" ]; then
        stop_web_processes TERM
        wait "$IMAGE_SERVICE_PID" 2>/dev/null || true
        wait "$TTYD_PID" 2>/dev/null || true
        wait "$SSH_BRIDGE_PID" 2>/dev/null || true
        wait "$HA_MONITOR_PID" 2>/dev/null || true
        trap - TERM INT
        return 0
    fi

    if ! kill -0 "$IMAGE_SERVICE_PID" 2>/dev/null; then
        bashio::log.error "Image service exited; stopping ttyd so Home Assistant can restart the add-on"
        exit_status=1
    elif ! kill -0 "$TTYD_PID" 2>/dev/null; then
        bashio::log.error "ttyd exited; stopping image service so Home Assistant can restart the add-on"
        exit_status="${wait_status:-1}"
        [ "$exit_status" -ne 0 ] || exit_status=1
    elif [ -n "${SSH_BRIDGE_PID:-}" ] && ! kill -0 "$SSH_BRIDGE_PID" 2>/dev/null; then
        bashio::log.error "SSH bridge exited; stopping web processes so Home Assistant can restart the add-on"
        exit_status=1
    elif [ -n "${HA_MONITOR_PID:-}" ] && ! kill -0 "$HA_MONITOR_PID" 2>/dev/null; then
        bashio::log.error "HA monitor exited; stopping web processes so Home Assistant can restart the add-on"
        exit_status=1
    else
        bashio::log.error "Web process supervisor woke without a child exit"
        exit_status=1
    fi

    stop_web_processes TERM
    wait "$IMAGE_SERVICE_PID" 2>/dev/null || true
    wait "$TTYD_PID" 2>/dev/null || true
    wait "$SSH_BRIDGE_PID" 2>/dev/null || true
    wait "$HA_MONITOR_PID" 2>/dev/null || true
    trap - TERM INT
    return "$exit_status"
}

start_ssh_bridge() {
    local bridge_bin="/opt/scripts/codex-terminal-ssh-bridge.sh"

    if [ ! -x "${bridge_bin}" ]; then
        bashio::log.warning "Home Assistant SSH bridge helper is not available at ${bridge_bin}"
        return 0
    fi

    bashio::log.info "Starting Home Assistant SSH bridge..."
    "${bridge_bin}" > >(
        while IFS= read -r line; do
            bashio::log.info "[SSH Bridge] ${line}"
        done
    ) 2>&1 &
    SSH_BRIDGE_PID=$!
    bashio::log.info "Home Assistant SSH bridge background PID: ${SSH_BRIDGE_PID}"
}

start_web_terminal() {
    local port=7681
    local launch_command
    local auto_launch_codex
    local tmux_session="codex-terminal"
    local tmux_config="/data/.tmux.conf"
    local tmux_launcher="/tmp/codex-terminal-launch.sh"
    local transcript="/data/logs/codex-terminal.log"
    local transcript_enabled
    local transcript_max_bytes
    local transcript_backups
    local terminal_history_limit

    bashio::log.info "Starting web terminal on port ${port}..."
    bashio::log.info "Environment variables:"
    bashio::log.info "CODEX_HOME=${CODEX_HOME}"
    bashio::log.info "GH_CONFIG_DIR=${GH_CONFIG_DIR}"
    bashio::log.info "HOME=${HOME}"

    launch_command=$(get_codex_launch_command)
    auto_launch_codex=$(bashio::config 'auto_launch_codex' 'true')
    transcript_enabled=$(bashio::config 'terminal_transcript_enabled' 'true')
    transcript_max_bytes=$(normalize_nonnegative_int "$(bashio::config 'terminal_transcript_max_bytes' '1048576')" "1048576")
    transcript_backups=$(normalize_nonnegative_int "$(bashio::config 'terminal_transcript_backups' '2')" "2")
    terminal_history_limit=$(normalize_nonnegative_int "$(bashio::config 'terminal_history_limit' '50000')" "50000")
    bashio::log.info "Auto-launch Codex: ${auto_launch_codex}"
    bashio::log.info "Persistent terminal session: tmux session '${tmux_session}'"
    bashio::log.info "Terminal history limit: ${terminal_history_limit}"
    export TMUX_SESSION="${tmux_session}"
    export TMUX_TARGET="${tmux_session}:0.0"
    export CODEX_TMUX_TARGET="${TMUX_TARGET}"
    write_tmux_config "${tmux_config}" "${terminal_history_limit}"
    write_tmux_launch_script "${tmux_launcher}" "${launch_command}"

    start_image_service
    prepare_tmux_session "${tmux_session}" "${tmux_launcher}" "${tmux_config}" "${transcript}" \
        "${transcript_enabled}" "${transcript_max_bytes}" "${transcript_backups}" "${terminal_history_limit}"
    start_ssh_bridge

    bashio::log.info "Final ttyd command: ttyd --port ${port} --interface 127.0.0.1 --writable --ping-interval 30 --client-option reconnect=5 --client-option macOptionClickForcesSelection=true --client-option rightClickSelectsWord=true tmux -f ${tmux_config} attach-session -t ${tmux_session}"

    ttyd \
        --port "${port}" \
        --interface 127.0.0.1 \
        --writable \
        --ping-interval 30 \
        --client-option reconnect=5 \
        --client-option macOptionClickForcesSelection=true \
        --client-option rightClickSelectsWord=true \
        tmux -f "${tmux_config}" attach-session -t "${tmux_session}" &
    TTYD_PID=$!
    bashio::log.info "ttyd started (PID: ${TTYD_PID}); supervising ttyd and image service"

    supervise_web_processes
}

run_health_check() {
    if [ -f "/opt/scripts/health-check.sh" ]; then
        bashio::log.info "Running system health check..."
        chmod +x /opt/scripts/health-check.sh
        /opt/scripts/health-check.sh || bashio::log.warning "Some health checks failed but continuing..."
    fi
}

run_health_check_background() {
    if [ -f "/opt/scripts/health-check.sh" ]; then
        bashio::log.info "Starting system health check in background..."
        (
            chmod +x /opt/scripts/health-check.sh
            /opt/scripts/health-check.sh || bashio::log.warning "Some health checks failed but continuing..."
        ) &
        bashio::log.info "Health check background PID: $!"
    fi
}

start_ha_monitor() {
    local monitor_enabled
    local monitor_bin="/opt/scripts/ha-monitor"
    local monitor_interval
    local monitor_log_lines
    local monitor_max_issues
    local monitor_summary_interval
    local monitor_reasoning_cooldown
    local monitor_reasoning_daily_budget
    local monitor_dispatch_max_chars
    local state_scan_enabled
    local mcp_status_enabled
    local monitor_args=()

    monitor_enabled=$(bashio::config 'ha_monitor_enabled' 'true')
    if [ "${monitor_enabled}" != "true" ]; then
        HA_MONITOR_PID=""
        bashio::log.info "HA monitor disabled"
        return 0
    fi

    if [ ! -x "${monitor_bin}" ]; then
        HA_MONITOR_PID=""
        bashio::log.warning "HA monitor helper is not available at ${monitor_bin}"
        return 0
    fi

    mkdir -p /data/monitor/tasks.d /data/logs
    chmod 700 /data/monitor /data/monitor/tasks.d /data/logs

    monitor_interval=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_interval_seconds' '300')" "300")
    monitor_log_lines=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_log_lines' '500')" "500")
    monitor_max_issues=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_max_issues' '20')" "20")
    monitor_summary_interval=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_summary_interval_seconds' '3600')" "3600")
    monitor_reasoning_cooldown=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_reasoning_cooldown_seconds' '3600')" "3600")
    monitor_reasoning_daily_budget=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_reasoning_daily_budget' '8')" "8")
    monitor_dispatch_max_chars=$(normalize_nonnegative_int "$(bashio::config 'ha_monitor_dispatch_max_chars' '12000')" "12000")
    state_scan_enabled=$(bashio::config 'ha_monitor_state_scan_enabled' 'true')
    mcp_status_enabled=$(bashio::config 'ha_monitor_mcp_status_enabled' 'true')

    monitor_args=(
        "--interval" "${monitor_interval}"
        "--log-lines" "${monitor_log_lines}"
        "--max-issues" "${monitor_max_issues}"
        "--state-file" "/data/monitor/ha-monitor.json"
        "--history-file" "/data/monitor/ha-monitor-history.jsonl"
        "--dispatch-file" "/data/monitor/change-desk-dispatch.json"
        "--task-dir" "/data/monitor/tasks.d"
        "--summary-interval-seconds" "${monitor_summary_interval}"
        "--reasoning-cooldown-seconds" "${monitor_reasoning_cooldown}"
        "--reasoning-daily-budget" "${monitor_reasoning_daily_budget}"
        "--dispatch-max-chars" "${monitor_dispatch_max_chars}"
    )

    if [ "${state_scan_enabled}" != "true" ]; then
        monitor_args+=("--no-state-scan")
    fi

    if [ "${mcp_status_enabled}" != "true" ]; then
        monitor_args+=("--no-mcp-status")
    fi

    bashio::log.info "Starting HA monitor: interval=${monitor_interval}s, log_lines=${monitor_log_lines}, max_issues=${monitor_max_issues}, dispatch=${monitor_dispatch_max_chars} chars"
    "${monitor_bin}" "${monitor_args[@]}" daemon > >(
        while IFS= read -r line; do
            bashio::log.info "[HA Monitor] ${line}"
        done
    ) 2>&1 &
    HA_MONITOR_PID=$!
    bashio::log.info "HA monitor background PID: ${HA_MONITOR_PID}"
}

main() {
    bashio::log.info "Initializing Codex Terminal Pro add-on..."

    init_environment
    install_tools
    setup_modbus_tools
    setup_ha_tools
    log_startup_diagnostics
    setup_session_picker
    setup_shell_dispatch_profile
    setup_host_ssh_attach_helper
    setup_persistent_packages
    setup_supervisor_broker
    start_ha_monitor
    run_health_check_background
    start_web_terminal
}

if [ "${CODEX_TERMINAL_RUN_LIBRARY_ONLY:-false}" != "true" ]; then
    main "$@"
fi
