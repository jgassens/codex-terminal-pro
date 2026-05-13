#!/usr/bin/with-contenv bashio

set -e
set -o pipefail

# Initialize environment for Codex CLI using /data, the persistent Home Assistant
# add-on storage volume.
init_environment() {
    local data_home="/data/home"
    local config_dir="/data/.config"
    local cache_dir="/data/.cache"
    local state_dir="/data/.local/state"
    local data_dir="/data/.local/share"
    local codex_home="/data/.codex"
    local gh_config_dir="/data/.config/gh"
    local persist_root="/data/packages"
    local persist_bin="$persist_root/bin"
    local persist_lib="$persist_root/lib"
    local persist_python="$persist_root/python"
    local image_dir="/data/images"
    local log_dir="/data/logs"

    bashio::log.info "Initializing Codex environment in /data..."

    if ! mkdir -p "$data_home" "$config_dir" "$cache_dir" "$state_dir" "$data_dir" \
                  "$codex_home" "$gh_config_dir" "$persist_bin" "$persist_lib" \
                  "$persist_python" "$image_dir" "$log_dir"; then
        bashio::log.error "Failed to create directories in /data"
        exit 1
    fi

    chmod 755 "$data_home" "$config_dir" "$cache_dir" "$state_dir" "$data_dir" \
              "$codex_home" "$gh_config_dir" "$persist_root" "$persist_bin" \
              "$persist_lib" "$persist_python" "$image_dir"
    chmod 700 "$log_dir"

    export HOME="$data_home"
    export XDG_CONFIG_HOME="$config_dir"
    export XDG_CACHE_HOME="$cache_dir"
    export XDG_STATE_HOME="$state_dir"
    export XDG_DATA_HOME="$data_dir"
    export CODEX_HOME="$codex_home"
    export GH_CONFIG_DIR="$gh_config_dir"

    ensure_codex_file_credentials

    if [ -f "$CODEX_HOME/auth.json" ]; then
        chmod 600 "$CODEX_HOME/auth.json"
    fi

    export PATH="$persist_bin:$persist_python/venv/bin:$PATH"
    export LD_LIBRARY_PATH="$persist_lib:${LD_LIBRARY_PATH:-}"
    export PKG_CONFIG_PATH="$persist_lib/pkgconfig:${PKG_CONFIG_PATH:-}"

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

export PATH="/data/packages/bin:/data/packages/python/venv/bin:$PATH"
export LD_LIBRARY_PATH="/data/packages/lib:${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="/data/packages/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

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

    touch "$config_file"
    chmod 644 "$config_file"

    if grep -q '^cli_auth_credentials_store[[:space:]]*=' "$config_file"; then
        sed -i 's/^cli_auth_credentials_store[[:space:]]*=.*/cli_auth_credentials_store = "file"/' "$config_file"
    else
        if [ -s "$config_file" ]; then
            printf '\n' >> "$config_file"
        fi
        printf 'cli_auth_credentials_store = "file"\n' >> "$config_file"
    fi
}

install_tools() {
    local missing=""

    command -v ttyd >/dev/null 2>&1 || missing="$missing ttyd"
    command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
    command -v jq >/dev/null 2>&1 || missing="$missing jq"
    command -v curl >/dev/null 2>&1 || missing="$missing curl"

    if [ -n "$missing" ]; then
        bashio::log.info "Installing missing runtime tools:${missing}"
        if ! apk add --no-cache $missing; then
            bashio::log.error "Failed to install required runtime tools:${missing}"
            exit 1
        fi
    fi
}

log_startup_diagnostics() {
    local app_name="${APP_NAME:-${ADDON_NAME:-Codex Terminal Pro}}"
    local app_version="${BUILD_VERSION:-${APP_VERSION:-0.1.5}}"

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
    bashio::log.info "  - which codex: $(which codex 2>/dev/null || true)"
    bashio::log.info "  - codex version: $(codex --version 2>&1 || true)"
    bashio::log.info "  - which ha: $(which ha 2>/dev/null || true)"
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

setup_persistent_packages() {
    if [ -f "/opt/scripts/persist-install" ]; then
        cp /opt/scripts/persist-install /usr/local/bin/persist-install
        chmod +x /usr/local/bin/persist-install
        bashio::log.info "Persistent package manager installed: persist-install"
    fi

    auto_install_packages
}

auto_install_packages() {
    local apk_packages
    local pip_packages

    apk_packages=$(bashio::config 'persistent_apk_packages' '[]')
    pip_packages=$(bashio::config 'persistent_pip_packages' '[]')

    if [ "$apk_packages" != "[]" ] && [ -n "$apk_packages" ]; then
        bashio::log.info "Auto-installing system packages from config..."
        echo "$apk_packages" | jq -r '.[]' | while read -r pkg; do
            if [ -n "$pkg" ]; then
                bashio::log.info "  Installing: $pkg"
                /usr/local/bin/persist-install "$pkg" || bashio::log.warning "Failed to install: $pkg"
            fi
        done
    fi

    if [ "$pip_packages" != "[]" ] && [ -n "$pip_packages" ]; then
        bashio::log.info "Auto-installing Python packages from config..."
        local all_packages
        all_packages=$(echo "$pip_packages" | jq -r '.[]' | tr '\n' ' ')

        if [ -n "$all_packages" ]; then
            bashio::log.info "  Installing: $all_packages"
            /usr/local/bin/persist-install --python $all_packages || bashio::log.warning "Failed to install Python packages"
        fi
    fi
}

get_codex_launch_command() {
    local auto_launch_codex
    auto_launch_codex=$(bashio::config 'auto_launch_codex' 'true')

    if [ "$auto_launch_codex" = "true" ]; then
        if [ -f /usr/local/bin/codex-session-picker ]; then
            echo "cd /config && clear && echo 'Welcome to Codex Terminal Pro' && echo '' && echo 'Starting Codex in /config...' && sleep 1 && codex; /usr/local/bin/codex-session-picker"
        else
            echo "cd /config && clear && echo 'Welcome to Codex Terminal Pro' && echo '' && echo 'Starting Codex in /config...' && sleep 1 && codex"
        fi
    else
        if [ -f /usr/local/bin/codex-session-picker ]; then
            echo "cd /config && clear && /usr/local/bin/codex-session-picker"
        else
            bashio::log.warning "Session picker not found, falling back to Codex auto-launch"
            echo "cd /config && clear && echo 'Welcome to Codex Terminal Pro' && echo '' && echo 'Starting Codex in /config...' && sleep 1 && codex"
        fi
    fi
}

write_tmux_config() {
    local tmux_config="$1"

    cat > "${tmux_config}" << 'TMUX_EOF'
set -g mouse on
set -g history-limit 200000
set -g status off
set -g escape-time 10
setw -g mode-keys vi
TMUX_EOF

    chmod 600 "${tmux_config}"
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
export PATH="${PATH}"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}"

${launch_command}
LAUNCH_EOF

    chmod 700 "${launcher}"
}

prepare_tmux_session() {
    local session="$1"
    local launcher="$2"
    local tmux_config="$3"
    local transcript="$4"

    touch "${transcript}"
    chmod 600 "${transcript}"

    if ! tmux -f "${tmux_config}" has-session -t "${session}" 2>/dev/null; then
        bashio::log.info "Creating tmux session '${session}'"
        tmux -f "${tmux_config}" new-session -d -s "${session}" "${launcher}"
    else
        bashio::log.info "Reusing existing tmux session '${session}'"
    fi

    tmux -f "${tmux_config}" set-option -g mouse on
    tmux -f "${tmux_config}" set-option -g history-limit 200000
    tmux -f "${tmux_config}" pipe-pane -t "${session}:0.0" -o "cat >> '${transcript}'" || \
        bashio::log.warning "Could not enable terminal transcript logging"
    bashio::log.info "Terminal transcript: ${transcript}"
}

start_image_service() {
    local image_port=7680
    local ttyd_port=7681
    local upload_dir="/data/images"
    local service_dir="/opt/image-service"
    local server_file="${service_dir}/server.js"

    bashio::log.info "Starting image upload service on port ${image_port}..."

    mkdir -p "${upload_dir}"
    chmod 755 "${upload_dir}"

    export IMAGE_SERVICE_PORT="${image_port}"
    export TTYD_PORT="${ttyd_port}"
    export UPLOAD_DIR="${upload_dir}"

    if [ ! -f "${server_file}" ]; then
        bashio::log.error "server.js not found at ${server_file}"
        ls -la "${service_dir}"
        return 1
    fi

    if [ ! -d "${service_dir}/node_modules" ]; then
        bashio::log.error "node_modules not found in ${service_dir}"
        bashio::log.info "Attempting to install dependencies..."
        cd "${service_dir}" && npm install || bashio::log.error "npm install failed"
        cd - > /dev/null
    fi

    node "${server_file}" 2>&1 | while IFS= read -r line; do
        bashio::log.info "[Image Service] $line"
    done &

    local image_service_pid=$!
    bashio::log.info "Image service started (PID: ${image_service_pid})"
    sleep 3

    if kill -0 "${image_service_pid}" 2>/dev/null; then
        bashio::log.info "Image service is running successfully"
    else
        bashio::log.error "Image service failed to start"
        return 1
    fi
}

start_web_terminal() {
    local port=7681
    local launch_command
    local auto_launch_codex
    local tmux_session="codex-terminal"
    local tmux_config="/data/.tmux.conf"
    local tmux_launcher="/tmp/codex-terminal-launch.sh"
    local transcript="/data/logs/codex-terminal.log"

    bashio::log.info "Starting web terminal on port ${port}..."
    bashio::log.info "Environment variables:"
    bashio::log.info "CODEX_HOME=${CODEX_HOME}"
    bashio::log.info "GH_CONFIG_DIR=${GH_CONFIG_DIR}"
    bashio::log.info "HOME=${HOME}"

    launch_command=$(get_codex_launch_command)
    auto_launch_codex=$(bashio::config 'auto_launch_codex' 'true')
    bashio::log.info "Auto-launch Codex: ${auto_launch_codex}"
    bashio::log.info "Persistent terminal session: tmux session '${tmux_session}'"
    write_tmux_config "${tmux_config}"
    write_tmux_launch_script "${tmux_launcher}" "${launch_command}"

    start_image_service
    prepare_tmux_session "${tmux_session}" "${tmux_launcher}" "${tmux_config}" "${transcript}"

    bashio::log.info "Final ttyd command: ttyd --port ${port} --interface 0.0.0.0 --writable --ping-interval 30 --client-option reconnect=5 tmux -f ${tmux_config} attach-session -t ${tmux_session}"

    exec ttyd \
        --port "${port}" \
        --interface 0.0.0.0 \
        --writable \
        --ping-interval 30 \
        --client-option reconnect=5 \
        tmux -f "${tmux_config}" attach-session -t "${tmux_session}"
}

run_health_check() {
    if [ -f "/opt/scripts/health-check.sh" ]; then
        bashio::log.info "Running system health check..."
        chmod +x /opt/scripts/health-check.sh
        /opt/scripts/health-check.sh || bashio::log.warning "Some health checks failed but continuing..."
    fi
}

main() {
    bashio::log.info "Initializing Codex Terminal Pro add-on..."

    init_environment
    install_tools
    log_startup_diagnostics
    setup_session_picker
    setup_persistent_packages
    run_health_check
    start_web_terminal
}

main "$@"
