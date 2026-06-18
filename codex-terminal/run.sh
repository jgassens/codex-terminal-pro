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
    local monitor_dir="/data/monitor"
    local supervisor_dir="/data/.supervisor"

    bashio::log.info "Initializing Codex environment in /data..."

    if ! mkdir -p "$data_home" "$config_dir" "$cache_dir" "$local_dir" "$state_dir" "$data_dir" \
                  "$codex_home" "$gh_config_dir" "$persist_bin" "$persist_lib" \
                  "$persist_python" "$guard_bin" "$guard_libexec" "$image_dir" "$log_dir" \
                  "$monitor_dir/tasks.d" "$supervisor_dir/confirm"; then
        bashio::log.error "Failed to create directories in /data"
        exit 1
    fi

    chmod 700 "$data_home" "$config_dir" "$cache_dir" "$local_dir" "$state_dir" \
              "$data_dir" "$codex_home" "$gh_config_dir" "$guard_root" "$guard_bin" \
              "$guard_libexec" "$monitor_dir" "$monitor_dir/tasks.d" "$supervisor_dir" "$supervisor_dir/confirm"
    chmod 755 "$persist_root" "$persist_bin" "$persist_lib" "$persist_python" "$image_dir"
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

    ensure_codex_file_credentials
    ensure_codex_update_prompt_disabled
    ensure_codex_tui_defaults
    remove_heygen_cached_plugin

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

    touch "$config_file"
    chmod 644 "$config_file"

    set_codex_top_level_config "$config_file" "cli_auth_credentials_store" '"file"'
}

ensure_codex_update_prompt_disabled() {
    local config_file="$CODEX_HOME/config.toml"

    set_codex_top_level_config "$config_file" "check_for_update_on_startup" "false"
    bashio::log.info "Codex CLI startup update prompt disabled; update Codex through add-on releases"
}

set_codex_top_level_config() {
    local config_file="$1"
    local key="$2"
    local value="$3"
    local tmp_file="${config_file}.tmp.$$"

    touch "$config_file"
    chmod 644 "$config_file"

    awk -v key="$key" -v value="$value" '
        BEGIN {
            inserted = 0
            in_table = 0
            key_pattern = "^[[:space:]]*" key "[[:space:]]*="
        }
        !inserted && !in_table && $0 ~ key_pattern {
            print key " = " value
            inserted = 1
            next
        }
        !inserted && $0 ~ /^[[:space:]]*\[/ {
            print key " = " value
            print ""
            inserted = 1
            in_table = 1
            print
            next
        }
        {
            if ($0 ~ /^[[:space:]]*\[/) {
                in_table = 1
            }
            print
        }
        END {
            if (!inserted) {
                print key " = " value
            }
        }
    ' "$config_file" > "$tmp_file"

    mv "$tmp_file" "$config_file"
    chmod 644 "$config_file"
}

ensure_codex_tui_defaults() {
    local config_file="$CODEX_HOME/config.toml"

    if grep -Eq '^[[:space:]]*status_line[[:space:]]*=' "$config_file"; then
        sanitize_codex_status_line "$config_file"
        bashio::log.info "Codex TUI status line already present; preserving user preference"
        return
    fi

    if grep -Eq '^[[:space:]]*(\[tui\]|tui\.)' "$config_file"; then
        bashio::log.info "Codex TUI config already present; leaving it unchanged"
        return
    fi

    write_codex_tui_defaults "$config_file"
}

sanitize_codex_status_line() {
    local config_file="$1"

    python3 - "$config_file" << 'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

# These are valid Codex concepts/settings, but the pinned 0.134.0 CLI does not
# accept them as [tui].status_line item IDs. Keep every other user-selected
# footer item intact.
unsupported_status_line_items = {"auto-review", "permissions", "approval-mode"}

def sanitize(match: re.Match[str]) -> str:
    prefix = match.group("prefix")
    body = match.group("body")
    suffix = match.group("suffix")
    items = re.findall(r'"([^"]+)"', body)
    if not items:
        return match.group(0)
    kept = [item for item in items if item not in unsupported_status_line_items]
    if kept == items:
        return match.group(0)
    if not kept:
        kept = [
            "run-state",
            "model-with-reasoning",
            "fast-mode",
            "context-remaining",
            "five-hour-limit",
            "weekly-limit",
        ]
    rendered = ", ".join(f'"{item}"' for item in kept)
    return f"{prefix}[{rendered}]{suffix}"

updated = re.sub(
    r'(?m)^(?P<prefix>[ \t]*status_line[ \t]*=[ \t]*)\[(?P<body>[^\n\]]*)\](?P<suffix>[ \t]*(?:#.*)?)$',
    sanitize,
    text,
)

if updated != text:
    path.write_text(updated, encoding="utf-8")
PY
}

write_codex_tui_defaults() {
    local config_file="$1"

    cat >> "$config_file" << 'TUI_EOF'

# Codex Terminal Pro default TUI. Edit or remove this block to customize.
[tui]
theme = "catppuccin-mocha"
status_line_use_colors = true
status_line = ["run-state", "model-with-reasoning", "fast-mode", "context-remaining", "five-hour-limit", "weekly-limit"]
TUI_EOF
}

remove_heygen_cached_plugin() {
    local heygen_cache="$CODEX_HOME/plugins/cache/openai-curated-remote/heygen"

    case "$heygen_cache" in
        /data/.codex/plugins/cache/openai-curated-remote/heygen)
            ;;
        *)
            bashio::log.warning "Refusing to remove unexpected HeyGen cache path: ${heygen_cache}"
            return 0
            ;;
    esac

    if [ ! -e "$heygen_cache" ] && [ ! -L "$heygen_cache" ]; then
        return 0
    fi

    if rm -rf -- "$heygen_cache"; then
        bashio::log.info "Removed irrelevant HeyGen Codex plugin cache from ${heygen_cache}"
        return 0
    fi

    bashio::log.warning "Failed to remove HeyGen Codex plugin cache from ${heygen_cache}"
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
    local app_version="${BUILD_VERSION:-${APP_VERSION:-2.5.6}}"

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
    bashio::log.info "  - codex version: $(codex --version 2>&1 || true)"
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

setup_host_ssh_attach_helper() {
    local source="/opt/scripts/codex-terminal-host-attach.sh"
    local target="/config/codex-terminal-pro-attach"

    if [ -f "${source}" ]; then
        if cp "${source}" "${target}"; then
            chmod 755 "${target}"
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

write_codex_terminal_agents_block() {
    local target_file="$1"
    local tmp_file

    tmp_file="$(mktemp)"
    awk '
        /^<!-- BEGIN CODEX TERMINAL PRO MANAGED GUIDANCE -->$/ { skip = 1; next }
        /^<!-- END CODEX TERMINAL PRO MANAGED GUIDANCE -->$/ { skip = 0; next }
        !skip { print }
    ' "$target_file" > "$tmp_file"

    cat >> "$tmp_file" <<'AGENTS_BLOCK'

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
- From a Home Assistant SSH shell with `/config` and Docker access, run
  `/config/codex-terminal-pro-attach` to attach to this add-on's live tmux
  session. From the raw HA OS host shell, use the Home Assistant config
  directory path instead. It discovers the GitHub or local add-on container name
  automatically. For SSH-side readback, `capture` and `transcript` can show
  recent output; `ask-file` is the reliable path because it asks Codex to write
  the answer under `/config`.
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
- Human Shell commands typed in Shell mode or dispatched with `,,` may run
  without a second broker confirmation. Codex/non-interactive management
  operations remain broker-guarded.
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

    mv "$tmp_file" "$target_file"
    chmod 644 "$target_file"
}

setup_supervisor_broker() {
    local guard_dir="/data/packages/guard/bin"
    local supervisor_dir="/data/.supervisor"
    local broker_enabled
    local broker_ttl
    local broker_comma_dispatch_enabled
    local target_agents="/config/AGENTS.md"
    local fallback_agents="/config/AGENTS.codex-terminal-pro.md"
    local briefing_file="/config/CODEX_TERMINAL_PRO.md"

    broker_enabled=$(bashio::config 'supervisor_broker_enabled' 'true')
    broker_ttl=$(normalize_nonnegative_int "$(bashio::config 'supervisor_broker_t1_ttl_seconds' '120')" "120")
    broker_comma_dispatch_enabled=$(bashio::config 'supervisor_broker_comma_dispatch_enabled' 'true')

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
SUPERVISOR_BROKER_COMMA_DISPATCH_ENABLED="${broker_comma_dispatch_enabled}"
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
        /usr/local/bin/codex-terminal-briefing > "$briefing_file"
        chmod 644 "$briefing_file"
        bashio::log.info "Codex Terminal Pro briefing written to $briefing_file"
    fi

    if [ -f /opt/scripts/codex-terminal-agents.md ]; then
        cp /opt/scripts/codex-terminal-agents.md "$fallback_agents"
        chmod 644 "$fallback_agents"
        if [ ! -e "$target_agents" ]; then
            cp "$fallback_agents" "$target_agents"
            chmod 644 "$target_agents"
            bashio::log.info "Installed Codex Terminal Pro agent guidance at $target_agents and $fallback_agents"
        else
            write_codex_terminal_agents_block "$target_agents"
            bashio::log.info "Existing /config/AGENTS.md preserved and updated with managed Codex Terminal Pro guidance; full guidance also written to $fallback_agents"
        fi
    fi

    unset SUPERVISOR_TOKEN
    bashio::log.info "Supervisor broker: enabled=${broker_enabled}, T1 TTL=${broker_ttl}s, comma dispatch=${broker_comma_dispatch_enabled}"
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
    export TMUX_SESSION="${tmux_session}"
    export TMUX_TARGET="${tmux_session}:0.0"
    export CODEX_TMUX_TARGET="${TMUX_TARGET}"
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
        bashio::log.info "HA monitor disabled"
        return 0
    fi

    if [ ! -x "${monitor_bin}" ]; then
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
    (
        "${monitor_bin}" "${monitor_args[@]}" daemon 2>&1 | while IFS= read -r line; do
            bashio::log.info "[HA Monitor] ${line}"
        done
    ) &
    bashio::log.info "HA monitor background PID: $!"
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

main "$@"
