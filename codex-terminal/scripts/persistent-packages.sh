#!/usr/bin/with-contenv bashio

# Persistent Package Manager for Codex Terminal Pro
# Installs packages to /data (persistent storage) instead of ephemeral container

set -euo pipefail

PERSIST_ROOT="${PERSIST_ROOT:-/data/packages}"
PERSIST_BIN="$PERSIST_ROOT/bin"
PERSIST_PYTHON="$PERSIST_ROOT/python"
PERSIST_APK_MANIFEST="$PERSIST_ROOT/apk-packages.txt"
PERSIST_PIP_MANIFEST="$PERSIST_PYTHON/requirements.txt"
PERSIST_PYTHON_MARKER="$PERSIST_PYTHON/interpreter-version"
PERSIST_PYTHON_LOCK="$PERSIST_PYTHON/.venv-operation.lock"
PERSIST_MANIFEST_UPDATER="${PERSIST_MANIFEST_UPDATER:-/opt/scripts/update-apk-manifest}"
PERSIST_LOCK_HELPER="${PERSIST_LOCK_HELPER:-/opt/scripts/update-apk-manifest}"
PERSIST_LOCK_PYTHON="${PERSIST_LOCK_PYTHON:-python3}"
PERSIST_SYSTEM_PYTHON="${PERSIST_SYSTEM_PYTHON:-python3}"
PERSIST_MIGRATION_MARKER="$PERSIST_ROOT/.manifest-package-migration-v2"
PERSIST_LEGACY_ROOT="$PERSIST_ROOT/legacy-copied-files"
PERSIST_PYTHON_LOCK_PID=""
PERSIST_PYTHON_LOCK_WRITE_FD=""

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

python_marker_for() {
    "$1" -c '
import platform
import sys

version = ".".join(str(part) for part in sys.version_info[:3])
cache_tag = sys.implementation.cache_tag or "none"
print(f"{sys.implementation.name}|{version}|{cache_tag}|{platform.machine()}")
'
}

current_python_marker() {
    python_marker_for "$PERSIST_SYSTEM_PYTHON"
}

write_python_marker() {
    local marker="$1"
    local marker_temp

    marker_temp="$(mktemp "$PERSIST_PYTHON/.interpreter-version.tmp.XXXXXX")" || return 1
    if ! printf '%s\n' "$marker" > "$marker_temp" ||
       ! chmod 600 "$marker_temp" ||
       ! mv -f "$marker_temp" "$PERSIST_PYTHON_MARKER"; then
        rm -f "$marker_temp"
        bashio::log.error "Could not record the persistent Python interpreter version"
        return 1
    fi
}

acquire_python_lock() {
    local read_fd
    local ready

    mkdir -p "$PERSIST_PYTHON"
    coproc PERSIST_PYTHON_LOCK_PROCESS {
        "$PERSIST_LOCK_PYTHON" "$PERSIST_LOCK_HELPER" \
            --hold-lock "$PERSIST_PYTHON_LOCK" "${PERSIST_PYTHON_LOCK_TIMEOUT_SECONDS:-30}"
    }
    read_fd="${PERSIST_PYTHON_LOCK_PROCESS[0]}"
    PERSIST_PYTHON_LOCK_WRITE_FD="${PERSIST_PYTHON_LOCK_PROCESS[1]}"
    PERSIST_PYTHON_LOCK_PID="$PERSIST_PYTHON_LOCK_PROCESS_PID"

    if ! IFS= read -r ready <&"$read_fd" || [ "$ready" != "locked" ]; then
        exec {read_fd}<&-
        exec {PERSIST_PYTHON_LOCK_WRITE_FD}>&-
        wait "$PERSIST_PYTHON_LOCK_PID" 2>/dev/null || true
        PERSIST_PYTHON_LOCK_PID=""
        PERSIST_PYTHON_LOCK_WRITE_FD=""
        bashio::log.error "Could not acquire the persistent Python package lock"
        return 1
    fi
    exec {read_fd}<&-
}

release_python_lock() {
    if [ -n "$PERSIST_PYTHON_LOCK_WRITE_FD" ]; then
        exec {PERSIST_PYTHON_LOCK_WRITE_FD}>&-
    fi
    if [ -n "$PERSIST_PYTHON_LOCK_PID" ]; then
        wait "$PERSIST_PYTHON_LOCK_PID" 2>/dev/null || true
    fi
    PERSIST_PYTHON_LOCK_PID=""
    PERSIST_PYTHON_LOCK_WRITE_FD=""
}

validate_pip_manifest() {
    local requirement
    local invalid="false"

    [ -s "$PERSIST_PIP_MANIFEST" ] || return 0
    while IFS= read -r requirement || [ -n "$requirement" ]; do
        [ -n "$requirement" ] || continue
        if ! is_safe_package_name "$requirement"; then
            bashio::log.error "Invalid persisted Python requirement: $requirement"
            invalid="true"
        fi
    done < "$PERSIST_PIP_MANIFEST"

    [ "$invalid" = "false" ]
}

write_empty_pip_manifest() {
    local manifest_temp

    manifest_temp="$(mktemp "$PERSIST_PYTHON/.requirements.tmp.XXXXXX")" || return 1
    if ! chmod 600 "$manifest_temp" || ! mv -f "$manifest_temp" "$PERSIST_PIP_MANIFEST"; then
        rm -f "$manifest_temp"
        return 1
    fi
}

bootstrap_legacy_pip_manifest() {
    local frozen
    local requirement
    local requirements=()

    [ -e "$PERSIST_PIP_MANIFEST" ] && return 0
    if ! frozen="$("$PERSIST_PYTHON/venv/bin/python" -m pip freeze)"; then
        bashio::log.error "Could not inventory legacy persistent Python packages; preserving the old venv"
        return 1
    fi

    while IFS= read -r requirement; do
        [ -n "$requirement" ] || continue
        if ! is_safe_package_name "$requirement"; then
            bashio::log.error "Cannot safely persist legacy Python requirement: $requirement"
            return 1
        fi
        requirements+=("$requirement")
    done <<< "$frozen"

    if [ "${#requirements[@]}" -eq 0 ]; then
        write_empty_pip_manifest || {
            bashio::log.error "Could not record the empty legacy Python package inventory"
            return 1
        }
    elif ! record_pip_manifest "${requirements[@]}"; then
        bashio::log.error "Could not record the legacy Python package inventory"
        return 1
    fi

    bashio::log.info "Recorded the legacy persistent Python package inventory"
}

rebuild_python_venv() {
    local staged_venv
    local previous_venv="$PERSIST_PYTHON/.venv.previous.$$"

    staged_venv="$(mktemp -d "$PERSIST_PYTHON/.venv.new.XXXXXX")" || return 1
    if ! "$PERSIST_SYSTEM_PYTHON" -m venv "$staged_venv"; then
        rm -rf "$staged_venv"
        bashio::log.error "Could not build a compatible persistent Python virtual environment"
        return 1
    fi

    rm -rf "$previous_venv"
    if [ -e "$PERSIST_PYTHON/venv" ]; then
        if ! mv "$PERSIST_PYTHON/venv" "$previous_venv"; then
            rm -rf "$staged_venv"
            return 1
        fi
    fi

    if ! mv "$staged_venv" "$PERSIST_PYTHON/venv"; then
        [ ! -e "$previous_venv" ] || mv "$previous_venv" "$PERSIST_PYTHON/venv"
        rm -rf "$staged_venv"
        return 1
    fi

    rm -rf "$previous_venv"
    rm -f "$PERSIST_PYTHON_MARKER"
}

ensure_python_environment_locked() {
    local expected_marker
    local live_venv_marker=""
    local saved_marker=""

    expected_marker="$(current_python_marker)" || {
        bashio::log.error "Could not identify the current Python interpreter"
        return 1
    }
    if [ -r "$PERSIST_PYTHON_MARKER" ]; then
        IFS= read -r saved_marker < "$PERSIST_PYTHON_MARKER" || true
    fi
    if [ -e "$PERSIST_PIP_MANIFEST" ] && ! normalize_pip_manifest; then
        bashio::log.error "Could not normalize the persisted Python requirements"
        return 1
    fi

    if [ -x "$PERSIST_PYTHON/venv/bin/python" ]; then
        live_venv_marker="$(python_marker_for "$PERSIST_PYTHON/venv/bin/python" 2>/dev/null || true)"
        bootstrap_legacy_pip_manifest || return 1
        if [ "$live_venv_marker" = "$expected_marker" ] && [ "$saved_marker" = "$expected_marker" ]; then
            return 0
        fi
        if [ "$live_venv_marker" = "$expected_marker" ] && [ -z "$saved_marker" ]; then
            write_python_marker "$expected_marker"
            return
        fi
    fi

    # Validate every saved line before replacing an existing environment. This
    # both blocks pip option injection and preserves the old venv on bad input.
    validate_pip_manifest || return 1

    if [ -e "$PERSIST_PYTHON/venv" ] || [ -e "$PERSIST_PYTHON_MARKER" ]; then
        bashio::log.warning "Persistent Python interpreter changed; rebuilding its virtual environment"
    else
        bashio::log.info "Creating persistent Python virtual environment..."
    fi

    rebuild_python_venv || return 1
    if [ -s "$PERSIST_PIP_MANIFEST" ]; then
        if ! "$PERSIST_PYTHON/venv/bin/python" -m pip install --requirement="$PERSIST_PIP_MANIFEST"; then
            bashio::log.error "Could not reinstall persisted Python requirements"
            return 1
        fi
    fi

    write_python_marker "$expected_marker"
}

restore_python_environment() {
    local status=0

    if [ ! -s "$PERSIST_PIP_MANIFEST" ] && [ ! -e "$PERSIST_PYTHON/venv" ]; then
        return 0
    fi
    acquire_python_lock || return 1
    ensure_python_environment_locked || status=$?
    release_python_lock
    return "$status"
}

validate_package_args() {
    local package

    for package in "$@"; do
        if ! is_safe_package_name "$package"; then
            bashio::log.error "Invalid package name: $package"
            return 1
        fi
    done
}

quarantine_legacy_package_copies() {
    local name
    local source
    local target
    local marker_temp
    local moved="false"

    [ -f "$PERSIST_MIGRATION_MARKER" ] && return 0
    mkdir -p "$PERSIST_ROOT" "$PERSIST_LEGACY_ROOT"
    chmod 700 "$PERSIST_LEGACY_ROOT"

    for name in lib; do
        source="$PERSIST_ROOT/$name"
        [ -d "$source" ] || continue
        if [ -n "$(find "$source" -mindepth 1 -print -quit 2>/dev/null)" ]; then
            target="$PERSIST_LEGACY_ROOT/$name"
            if [ -e "$target" ]; then
                target="$target.$(date +%s).$$"
            fi
            mv "$source" "$target"
            moved="true"
            bashio::log.warning "Quarantined legacy copied package files at $target"
        else
            rmdir "$source" 2>/dev/null || true
        fi
    done

    mkdir -p "$PERSIST_BIN"
    chmod 755 "$PERSIST_BIN"
    marker_temp="$PERSIST_ROOT/.manifest-package-migration-v2.tmp.$$"
    printf 'manifest package restore enabled\n' > "$marker_temp"
    chmod 600 "$marker_temp"
    mv -f "$marker_temp" "$PERSIST_MIGRATION_MARKER"

    if [ "$moved" = "true" ]; then
        bashio::log.warning "Legacy shared libraries were preserved but removed from automatic loading"
    fi
}

record_apk_manifest() {
    "$PERSIST_MANIFEST_UPDATER" --kind apk "$PERSIST_APK_MANIFEST" "$@"
}

record_pip_manifest() {
    "$PERSIST_MANIFEST_UPDATER" --kind pip "$PERSIST_PIP_MANIFEST" "$@"
}

normalize_apk_manifest() {
    "$PERSIST_MANIFEST_UPDATER" --kind apk "$PERSIST_APK_MANIFEST"
}

normalize_pip_manifest() {
    "$PERSIST_MANIFEST_UPDATER" --kind pip "$PERSIST_PIP_MANIFEST"
}

# Install complete APK packages and persist the requested package manifest.
persist_apk_install() {
    local packages=("$@")

    if [ "${#packages[@]}" -eq 0 ]; then
        bashio::log.error "No packages specified"
        return 1
    fi

    validate_package_args "${packages[@]}" || return 1

    bashio::log.info "Installing APK packages to persistent storage: ${packages[*]}"

    # Install to system first (needed for dependencies)
    apk add --no-cache -- "${packages[@]}"

    if ! record_apk_manifest "${packages[@]}"; then
        bashio::log.error "APK packages were installed, but their persistent manifest could not be updated"
        return 1
    fi

    bashio::log.info "APK packages installed; manifest will restore complete packages after updates"
}

restore_apk_manifest() {
    local package
    local failures=()

    [ -s "$PERSIST_APK_MANIFEST" ] || return 0
    if ! normalize_apk_manifest; then
        failures+=("manifest-normalization")
        bashio::log.error "Could not normalize the persistent APK manifest"
    fi
    while IFS= read -r package || [ -n "$package" ]; do
        [ -n "$package" ] || continue
        if ! is_safe_package_name "$package"; then
            failures+=("$package")
            bashio::log.error "Rejected invalid persistent APK package: $package"
            continue
        fi
        if ! apk add --no-cache -- "$package"; then
            failures+=("$package")
            bashio::log.error "Could not restore persistent APK package: $package"
        fi
    done < "$PERSIST_APK_MANIFEST"

    if [ "${#failures[@]}" -gt 0 ]; then
        bashio::log.error "Persistent APK restore failed for: ${failures[*]}"
        return 1
    fi
}

# Install Python package to persistent virtual environment
persist_pip_install() {
    local packages=("$@")
    local status=0

    if [ "${#packages[@]}" -eq 0 ]; then
        bashio::log.error "No packages specified"
        return 1
    fi

    validate_package_args "${packages[@]}" || return 1

    bashio::log.info "Installing Python packages to persistent venv: ${packages[*]}"

    acquire_python_lock || return 1
    ensure_python_environment_locked || status=$?
    if [ "$status" -eq 0 ]; then
        "$PERSIST_PYTHON/venv/bin/python" -m pip install --upgrade -- pip || status=$?
    fi
    if [ "$status" -eq 0 ]; then
        "$PERSIST_PYTHON/venv/bin/python" -m pip install -- "${packages[@]}" || status=$?
    fi
    if [ "$status" -eq 0 ]; then
        record_pip_manifest "${packages[@]}" || status=$?
    fi
    release_python_lock

    if [ "$status" -ne 0 ]; then
        bashio::log.error "Python package installation or persistence failed"
        return "$status"
    fi

    bashio::log.info "Python packages installed successfully"
}

# Auto-install packages from configuration
auto_install_packages() {
    local apk_packages
    local pip_packages
    local pkg
    local status=0

    if ! apk_packages="$(bashio::config 'persistent_apk_packages' '')"; then
        bashio::log.error "Could not read persistent_apk_packages configuration"
        return 1
    fi
    if ! pip_packages="$(bashio::config 'persistent_pip_packages' '')"; then
        bashio::log.error "Could not read persistent_pip_packages configuration"
        return 1
    fi

    # Parse and install APK packages
    if [ -n "$apk_packages" ]; then
        bashio::log.info "Auto-installing APK packages from config..."
        local pkg_list=()
        while IFS= read -r pkg; do
            [ -n "$pkg" ] || continue
            if ! is_safe_package_name "$pkg"; then
                bashio::log.error "Rejected invalid configured APK package: $pkg"
                status=1
                continue
            fi
            pkg_list+=("$pkg")
        done <<< "$apk_packages"
        if [ "${#pkg_list[@]}" -gt 0 ]; then
            persist_apk_install "${pkg_list[@]}" || status=$?
        fi
    fi

    # Parse and install Python packages
    if [ -n "$pip_packages" ]; then
        bashio::log.info "Auto-installing Python packages from config..."
        local pkg_list=()
        while IFS= read -r pkg; do
            [ -n "$pkg" ] || continue
            if ! is_safe_package_name "$pkg"; then
                bashio::log.error "Rejected invalid configured Python package: $pkg"
                status=1
                continue
            fi
            pkg_list+=("$pkg")
        done <<< "$pip_packages"
        if [ "${#pkg_list[@]}" -gt 0 ]; then
            persist_pip_install "${pkg_list[@]}" || status=$?
        fi
    fi

    return "$status"
}

# Show installed persistent packages
list_persistent_packages() {
    echo "=== Persistent Packages ==="
    echo ""
    echo "Binaries in $PERSIST_BIN:"
    ls -lh "$PERSIST_BIN" 2>/dev/null || echo "  (none)"
    echo ""
    echo "Python packages in virtual environment:"
    if [ -x "$PERSIST_PYTHON/venv/bin/python" ]; then
        "$PERSIST_PYTHON/venv/bin/python" -m pip list
    else
        echo "  (virtual environment not created)"
    fi
}

if [ "${PERSIST_PACKAGE_MANAGER_LIBRARY_ONLY:-false}" != "true" ]; then
    case "${1:-}" in
        migrate)
            quarantine_legacy_package_copies
            ;;
        restore)
            restore_apk_manifest
            ;;
        restore-pip)
            restore_python_environment
            ;;
        auto-install)
            auto_install_packages
            ;;
        install-apk)
            shift
            persist_apk_install "$@"
            ;;
        install-pip)
            shift
            persist_pip_install "$@"
            ;;
        list)
            list_persistent_packages
            ;;
        *)
            bashio::log.error "Unknown command: ${1:-<missing>}"
            echo "Usage: $0 {migrate|restore|restore-pip|auto-install|install-apk|install-pip|list}"
            exit 1
            ;;
    esac
fi
