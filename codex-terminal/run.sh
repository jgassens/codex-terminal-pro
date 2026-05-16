#!/usr/bin/with-contenv bashio

set -e
set -o pipefail

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
    local persist_lib="$persist_root/lib"
    local persist_python="$persist_root/python"
    local image_dir="/data/images"
    local log_dir="/data/logs"
    local supervisor_dir="/data/.supervisor"

    bashio::log.info "Initializing Codex environment in /data..."

    if ! mkdir -p "$data_home" "$config_dir" "$cache_dir" "$local_dir" "$state_dir" "$data_dir" \
                  "$codex_home" "$gh_config_dir" "$persist_bin" "$persist_lib" \
                  "$persist_python" "$guard_bin" "$guard_libexec" "$image_dir" "$log_dir" \
                  "$supervisor_dir/confirm"; then
        bashio::log.error "Failed to create directories in /data"
        exit 1
    fi

    chmod 700 "$data_home" "$config_dir" "$cache_dir" "$local_dir" "$state_dir" \
              "$data_dir" "$codex_home" "$gh_config_dir" "$guard_root" "$guard_bin" \
              "$guard_libexec" "$supervisor_dir" "$supervisor_dir/confirm"
    chmod 755 "$persist_root" "$persist_bin" "$persist_lib" "$persist_python" "$image_dir"
    chmod 700 "$log_dir"

    export HOME="$data_home"
    export XDG_CONFIG_HOME="$config_dir"
    export XDG_CACHE_HOME="$cache_dir"
    export XDG_STATE_HOME="$state_dir"
    export XDG_DATA_HOME="$data_dir"
    export CODEX_HOME="$codex_home"
    export GH_CONFIG_DIR="$gh_config_dir"

    ensure_codex_file_credentials
    ensure_codex_tui_defaults

    if [ -f "$CODEX_HOME/auth.json" ]; then
        chmod 600 "$CODEX_HOME/auth.json"
    fi

    export PATH="$guard_bin:$persist_bin:$persist_python/venv/bin:$PATH"
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

export PATH="/data/packages/guard/bin:/data/packages/bin:/data/packages/python/venv/bin:$PATH"
export LD_LIBRARY_PATH="/data/packages/lib:${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="/data/packages/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
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

ensure_codex_tui_defaults() {
    local config_file="$CODEX_HOME/config.toml"

    if grep -q '^# Codex Terminal Pro default footer\.' "$config_file" && \
       grep -q '^status_line = \["model-with-reasoning", "context-remaining", "current-dir", "git-branch"\]' "$config_file"; then
        bashio::log.info "Updating managed Codex Terminal Pro TUI defaults"
        sed -i '/^# Codex Terminal Pro default footer\./,$d' "$config_file"
        write_codex_tui_defaults "$config_file"
        return
    fi

    if grep -q '^# Codex Terminal Pro default TUI\.' "$config_file" && \
       grep -Eq '^status_line = .*("context-used"|"permissions"|"approval-mode"|"five-hour-limit"|"weekly-limit"|"branch-changes"|"pull-request-number"|"codex-version")' "$config_file"; then
        bashio::log.info "Updating managed Codex Terminal Pro TUI defaults"
        sed -i '/^# Codex Terminal Pro default TUI\./,$d' "$config_file"
        write_codex_tui_defaults "$config_file"
        return
    fi

    if grep -Eq '^[[:space:]]*(\[tui\]|tui\.|status_line[[:space:]]*=)' "$config_file"; then
        bashio::log.info "Codex TUI config already present; leaving it unchanged"
        return
    fi

    write_codex_tui_defaults "$config_file"
}

write_codex_tui_defaults() {
    local config_file="$1"

    cat >> "$config_file" << 'TUI_EOF'

# Codex Terminal Pro default TUI. Edit or remove this block to customize.
[tui]
theme = "catppuccin-mocha"
status_line_use_colors = true
status_line = ["run-state", "model-with-reasoning", "context-remaining", "current-dir", "git-branch"]
TUI_EOF
}

install_tools() {
    local missing=()

    command -v ttyd >/dev/null 2>&1 || missing+=("ttyd")
    command -v tmux >/dev/null 2>&1 || missing+=("tmux")
    command -v bwrap >/dev/null 2>&1 || missing+=("bubblewrap")
    command -v rg >/dev/null 2>&1 || missing+=("ripgrep")
    command -v jq >/dev/null 2>&1 || missing+=("jq")
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
    local app_version="${BUILD_VERSION:-${APP_VERSION:-0.1.25}}"

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

is_safe_package_name() {
    case "$1" in
        ''|*[!A-Za-z0-9@._:+!=\>\<,\[\]~-]*)
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

    apk_packages=$(bashio::config 'persistent_apk_packages' '[]')
    pip_packages=$(bashio::config 'persistent_pip_packages' '[]')

    if [ "$apk_packages" != "[]" ] && [ -n "$apk_packages" ]; then
        bashio::log.info "Auto-installing system packages from config..."
        echo "$apk_packages" | jq -r '.[]' | while read -r pkg; do
            if [ -n "$pkg" ]; then
                if ! is_safe_package_name "$pkg"; then
                    bashio::log.warning "Skipping invalid system package name: $pkg"
                    continue
                fi
                bashio::log.info "  Installing: $pkg"
                /usr/local/bin/persist-install "$pkg" || bashio::log.warning "Failed to install: $pkg"
            fi
        done
    fi

    if [ "$pip_packages" != "[]" ] && [ -n "$pip_packages" ]; then
        bashio::log.info "Auto-installing Python packages from config..."
        local pip_args=()
        local pkg

        while IFS= read -r pkg; do
            if [ -z "$pkg" ]; then
                continue
            fi
            if ! is_safe_package_name "$pkg"; then
                bashio::log.warning "Skipping invalid Python package name: $pkg"
                continue
            fi
            pip_args+=("$pkg")
        done < <(echo "$pip_packages" | jq -r '.[]')

        if [ "${#pip_args[@]}" -gt 0 ]; then
            bashio::log.info "  Installing: ${pip_args[*]}"
            /usr/local/bin/persist-install --python "${pip_args[@]}" || bashio::log.warning "Failed to install Python packages"
        fi
    fi
}

setup_supervisor_broker() {
    local guard_dir="/data/packages/guard/bin"
    local supervisor_dir="/data/.supervisor"
    local broker_enabled
    local broker_ttl
    local target_agents="/config/AGENTS.md"
    local fallback_agents="/config/AGENTS.codex-terminal-pro.md"

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

    if [ -f /opt/scripts/codex-terminal-agents.md ]; then
        if [ ! -e "$target_agents" ]; then
            cp /opt/scripts/codex-terminal-agents.md "$target_agents"
            chmod 644 "$target_agents"
            bashio::log.info "Installed Codex Terminal Pro agent guidance at $target_agents"
        else
            cp /opt/scripts/codex-terminal-agents.md "$fallback_agents"
            chmod 644 "$fallback_agents"
            bashio::log.info "Existing /config/AGENTS.md preserved; wrote add-on guidance to $fallback_agents"
        fi
    fi

    unset SUPERVISOR_TOKEN
    bashio::log.info "Supervisor broker: enabled=${broker_enabled}, T1 TTL=${broker_ttl}s"
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
    local history_limit="$2"

    cat > "${tmux_config}" << TMUX_EOF
set -g mouse on
set -g history-limit ${history_limit}
set -g status off
set -g escape-time 10
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
export PATH="${PATH}"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}"
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

    node "${server_file}" 2>&1 | while IFS= read -r line; do
        bashio::log.info "[Image Service] $line"
    done &

    local image_service_pid=$!
    bashio::log.info "Image service started (PID: ${image_service_pid})"

    for i in $(seq 1 20); do
        if curl -fsS "http://127.0.0.1:${image_port}/health" >/dev/null 2>&1; then
            image_service_ready="true"
            break
        fi

        if ! kill -0 "${image_service_pid}" 2>/dev/null; then
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
    export TMUX_TARGET="${tmux_session}:0.0"
    write_tmux_config "${tmux_config}" "${terminal_history_limit}"
    write_tmux_launch_script "${tmux_launcher}" "${launch_command}"

    start_image_service
    prepare_tmux_session "${tmux_session}" "${tmux_launcher}" "${tmux_config}" "${transcript}" \
        "${transcript_enabled}" "${transcript_max_bytes}" "${transcript_backups}" "${terminal_history_limit}"

    bashio::log.info "Final ttyd command: ttyd --port ${port} --interface 127.0.0.1 --writable --ping-interval 30 --client-option reconnect=5 --client-option macOptionClickForcesSelection=true --client-option rightClickSelectsWord=true tmux -f ${tmux_config} attach-session -t ${tmux_session}"

    exec ttyd \
        --port "${port}" \
        --interface 127.0.0.1 \
        --writable \
        --ping-interval 30 \
        --client-option reconnect=5 \
        --client-option macOptionClickForcesSelection=true \
        --client-option rightClickSelectsWord=true \
        tmux -f "${tmux_config}" attach-session -t "${tmux_session}"
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

main() {
    bashio::log.info "Initializing Codex Terminal Pro add-on..."

    init_environment
    install_tools
    log_startup_diagnostics
    setup_session_picker
    setup_persistent_packages
    setup_supervisor_broker
    run_health_check_background
    start_web_terminal
}

main "$@"
