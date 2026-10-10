#!/usr/bin/env python3
"""Stage stable Codex CLI releases in /data and select them at process launch.

This program never reads Codex credentials. The add-on image's CLI remains the
fallback if persistent state or an installed release is damaged.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import platform
import re
import select as io_select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(os.environ.get("CODEX_CLI_ROOT", "/data/packages/codex-cli"))
BUNDLED = Path(os.environ.get("CODEX_CLI_BUNDLED_BIN", "/usr/local/bin/codex"))
NPM = os.environ.get("CODEX_CLI_NPM_BIN", "npm")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
CHECK_INTERVAL = 24 * 60 * 60
ARCH = {"x86_64": "amd64", "aarch64": "aarch64", "arm64": "aarch64"}.get(platform.machine())


def version_tuple(value: str) -> tuple[int, int, int]:
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        raise ValueError("Release is not a stable semantic version")
    return tuple(map(int, value.split(".")))


def run(argv: list[str], timeout: int = 15, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=True, **kwargs)


def cli_version(binary: Path) -> str:
    output = run([str(binary), "--version"]).stdout.strip()
    match = re.fullmatch(r"codex-cli (\d+\.\d+\.\d+)", output)
    if not match:
        raise ValueError("Codex CLI version check returned an unexpected result")
    return match.group(1)


def release_dir(version: str) -> Path:
    version_tuple(version)
    if ARCH is None:
        raise ValueError("Unsupported architecture")
    return ROOT / "releases" / f"{version}-{ARCH}"


def release_binary(version: str) -> Path:
    return release_dir(version) / "node_modules" / ".bin" / "codex"


def installed(version: str) -> bool:
    try:
        binary = release_binary(version)
        return binary.is_file() and os.access(binary, os.X_OK)
    except (ValueError, OSError):
        return False


def read_state() -> dict:
    try:
        state = json.loads((ROOT / "state.json").read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def atomic_state(state: dict) -> None:
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.chmod(ROOT, 0o755)
    fd, name = tempfile.mkstemp(prefix=".state-", dir=ROOT)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, 0o600)
        os.replace(name, ROOT / "state.json")
        directory_fd = os.open(ROOT, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def state_lock():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.chmod(ROOT, 0o755)
    fd = os.open(ROOT / ".state.lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def pointer_binary(pointer: str) -> Path:
    if pointer == "bundled":
        return BUNDLED
    if not isinstance(pointer, str) or not installed(pointer):
        raise ValueError("Selected release is missing")
    return release_binary(pointer)


def healthy_pointer(pointer: str, bundled_version: str) -> str:
    try:
        binary = pointer_binary(pointer)
        version = bundled_version if pointer == "bundled" else pointer
        if version_tuple(version) < version_tuple(bundled_version):
            return "bundled"
        if cli_version(binary) != version:
            return "bundled"
        return pointer
    except (OSError, ValueError, subprocess.SubprocessError):
        return "bundled"


def current_status() -> dict:
    state = read_state()
    bundled = cli_version(BUNDLED)
    selected = healthy_pointer(state.get("selected", "bundled"), bundled)
    ready = state.get("ready")
    if ready != "bundled" and not (isinstance(ready, str) and installed(ready)):
        ready = None
    return {
        "bundled": bundled,
        "selected": bundled if selected == "bundled" else selected,
        "selectedSource": selected,
        "ready": bundled if ready == "bundled" else ready,
        "previous": state.get("previous"),
        "available": state.get("available"),
        "lastCheck": state.get("lastCheck"),
        "error": state.get("error"),
        "autoUpdate": state.get("autoUpdate", True) is not False,
        "architecture": ARCH,
    }


def safe_npm_env() -> dict:
    # npm needs network and a cache, but must not inherit HA or provider tokens.
    names = ("PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE")
    env = {name: os.environ[name] for name in names if name in os.environ}
    env.update({"HOME": "/tmp", "npm_config_cache": str(ROOT / "npm-cache"),
                "npm_config_userconfig": "/dev/null"})
    return env


def stage(version: str) -> None:
    target = release_dir(version)
    if target.exists():
        if cli_version(release_binary(version)) != version:
            raise ValueError("Existing release failed validation")
        return
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.chmod(target.parent, 0o755)
    temporary = Path(tempfile.mkdtemp(prefix=".stage-", dir=target.parent))
    try:
        run([NPM, "install", "--prefix", str(temporary), f"@openai/codex@{version}",
             "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"],
            timeout=300, env=safe_npm_env())
        binary = temporary / "node_modules" / ".bin" / "codex"
        if cli_version(binary) != version:
            raise ValueError("Installed release version does not match npm stable tag")
        if "--no-daemon" not in run([str(binary), "--help"]).stdout:
            raise ValueError("Installed release lacks standalone mode")
        daemon_help = run([str(binary), "app-server", "daemon", "--help"]).stdout
        if "restart" not in daemon_help or "version" not in daemon_help:
            raise ValueError("Installed release lacks daemon management")
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def check(force: bool) -> dict:
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
    with open(ROOT / ".check.lock", "a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"success": False, "busy": True, "error": "An update check is already running"}
        state = read_state()
        initial_ready = state.get("ready")
        last_check = state.get("lastCheck")
        checked_recently = (isinstance(last_check, (int, float)) and
                            0 <= time.time() - last_check < CHECK_INTERVAL)
        if not force and (state.get("autoUpdate") is False or
                          checked_recently):
            return {"success": True, "skipped": True, **current_status()}
        try:
            latest = json.loads(run(
                [NPM, "view", "@openai/codex", "dist-tags.latest", "--json",
                 "--registry=https://registry.npmjs.org/"],
                timeout=45, env=safe_npm_env()).stdout)
            version_tuple(latest)
            bundled = cli_version(BUNDLED)
            selected = current_status()["selected"]
            state["available"] = latest
            if version_tuple(latest) > max(version_tuple(bundled), version_tuple(selected)):
                stage(latest)
                state["ready"] = latest
            state["error"] = None
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            # Do not expose npm output or environment variables in HTTP/logs.
            state["error"] = f"Update check failed ({type(exc).__name__})"
        state["lastCheck"] = int(time.time())
        with state_lock():
            fresh = read_state()
            # Preserve preference/rollback/launch changes made during download.
            fresh.update({key: state.get(key) for key in
                          ("available", "error", "lastCheck")})
            if fresh.get("ready") == initial_ready:
                fresh["ready"] = state.get("ready")
            atomic_state(fresh)
        return {"success": state["error"] is None, **current_status()}


def set_auto(enabled: bool) -> dict:
    with state_lock():
        state = read_state()
        state["autoUpdate"] = enabled
        atomic_state(state)
    return current_status()


def rollback() -> dict:
    with state_lock():
        state = read_state()
        selected = state.get("selected", "bundled")
        previous = state.get("previous")
        if not previous or previous == selected:
            previous = "bundled"
        if previous != "bundled" and not installed(previous):
            previous = "bundled"
        state["ready"] = previous
        atomic_state(state)
    return current_status()


def select() -> dict:
    bundled = cli_version(BUNDLED)
    with state_lock():
        state = read_state()
        selected = healthy_pointer(state.get("selected", "bundled"), bundled)
        ready = state.get("ready")
        if ready is not None:
            next_selected = healthy_pointer(ready, bundled)
            if next_selected != selected:
                state["previous"] = selected
            selected = next_selected
            state["selected"] = selected
            state["ready"] = None
            atomic_state(state)
        elif selected != state.get("selected", "bundled"):
            state["previous"] = state.get("selected")
            state["selected"] = selected
            atomic_state(state)
    return {"binary": str(pointer_binary(selected)),
            "version": bundled if selected == "bundled" else selected}


def daemon_version(binary: Path) -> str | None:
    try:
        data = json.loads(run([str(binary), "app-server", "daemon", "version"], timeout=8).stdout)
        if not isinstance(data, dict):
            return None
        # CLI versions have used both spellings. An unknown shape is unsafe.
        for key in ("app_server_version", "appServerVersion", "server_version",
                    "serverVersion", "runningAppServerVersion", "running_app_server_version",
                    "daemonVersion", "daemon_version"):
            value = data.get(key)
            if isinstance(value, str) and VERSION_RE.fullmatch(value):
                return value
            if isinstance(value, dict):
                nested = value.get("version")
                if isinstance(nested, str) and VERSION_RE.fullmatch(nested):
                    return nested
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def other_cli_running() -> bool:
    """A connected CLI could have work even when every listed turn is idle."""
    try:
        output = run(["ps", "-e", "-o", "comm=,args="], timeout=5).stdout
        for line in output.splitlines():
            parts = line.strip().split(maxsplit=1)
            if len(parts) != 2:
                continue
            comm, args = parts
            if not comm.startswith("codex"):
                continue
            daemon_process = re.search(
                r"\sapp-server\s+(?:--listen\b|daemon\s+pid-update-loop\b|proxy\b)",
                args,
            )
            if not daemon_process:
                return True
    except (OSError, subprocess.SubprocessError):
        return True
    return False


def daemon_threads_idle(binary: Path) -> bool:
    """Ask the running daemon for *all* thread statuses; fail closed on errors."""
    if other_cli_running():
        return False
    process = None
    try:
        process = subprocess.Popen(
            [str(binary), "app-server", "proxy"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        assert process.stdin and process.stdout

        def request(request_id: int, method: str, params: dict) -> dict:
            process.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                ready, _, _ = io_select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
                response = json.loads(process.stdout.readline())
                if response.get("id") == request_id:
                    if "error" in response:
                        raise ValueError("Daemon rejected idle probe")
                    return response.get("result", {})
            raise TimeoutError("Daemon idle probe timed out")

        request(1, "initialize", {"clientInfo": {
            "name": "codex_terminal_pro_updater", "title": "Codex Terminal Pro updater", "version": "2.14.0"
        }})
        process.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
        process.stdin.flush()
        cursor = None
        for page in range(10):
            params = {"limit": 100}
            if cursor is not None:
                params["cursor"] = cursor
            result = request(page + 2, "thread/list", params)
            threads = result.get("data")
            if not isinstance(threads, list):
                return False
            if any(not isinstance(thread, dict) or
                   not isinstance(thread.get("status"), dict) or
                   thread["status"].get("type") not in ("idle", "notLoaded")
                   for thread in threads):
                return False
            cursor = result.get("nextCursor")
            if cursor is None:
                return not other_cli_running()
        return False
    except (OSError, ValueError, TimeoutError, subprocess.SubprocessError):
        return False
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                pass


def standalone_for(binary: Path, version: str) -> tuple[bool, str | None]:
    socket = Path(os.environ.get("CODEX_HOME", "/data/.codex")) / "app-server-control" / "app-server-control.sock"
    if not socket.exists():
        return False, None
    running = daemon_version(binary)
    if running == version:
        return False, running
    if running is not None and daemon_threads_idle(binary):
        try:
            run([str(binary), "app-server", "daemon", "restart"], timeout=40)
            updated = daemon_version(binary)
            if updated == version:
                return False, updated
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return True, running


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("status", "check", "select", "select-local",
                                           "rollback", "set-auto"))
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    if args.action == "status":
        result = current_status()
        selected_binary = pointer_binary(result["selectedSource"])
        socket = Path(os.environ.get("CODEX_HOME", "/data/.codex")) / "app-server-control" / "app-server-control.sock"
        result["daemonRunning"] = socket.exists()
        result["daemonVersion"] = daemon_version(selected_binary) if socket.exists() else None
    elif args.action == "check":
        result = check(args.value == "force")
    elif args.action == "rollback":
        result = rollback()
    elif args.action == "set-auto":
        if args.value not in ("true", "false"):
            parser.error("set-auto requires true or false")
        result = set_auto(args.value == "true")
    else:
        result = select()
        if args.action == "select-local":
            result["standalone"], result["daemonVersion"] = True, None
        else:
            result["standalone"], result["daemonVersion"] = standalone_for(
                Path(result["binary"]), result["version"])
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
