#!/usr/bin/python3
"""Enter the fixed Mall Cop filesystem jail, drop privilege, and exec Codex."""

from __future__ import annotations

import argparse
import ctypes
import os
import re
import stat
import sys
from pathlib import Path


DEFAULT_JAIL_ROOT = Path("/opt/mall-cop-jail")
JAIL_OWNER_UID = 0
UNPRIVILEGED_UID = 65534
UNPRIVILEGED_GID = 65534
PR_SET_NO_NEW_PRIVS = 38
SAFE_CWD_RE = re.compile(r"^/work/run-[A-Za-z0-9_-]+$")


class JailError(RuntimeError):
    """Raised when the requested jail boundary is unsafe or incomplete."""


def validate_jail(jail_root: Path, cwd: str, command: list[str]) -> None:
    if not jail_root.is_absolute() or jail_root != DEFAULT_JAIL_ROOT:
        raise JailError("Mall Cop jail root must be the fixed image-owned path")
    jail_stat = jail_root.lstat()
    if not stat.S_ISDIR(jail_stat.st_mode) or stat.S_ISLNK(jail_stat.st_mode):
        raise JailError("Mall Cop jail root must be a real directory")
    if jail_stat.st_uid != JAIL_OWNER_UID or jail_stat.st_mode & 0o022:
        raise JailError("Mall Cop jail root must be root-owned and not group/world writable")
    if not SAFE_CWD_RE.fullmatch(cwd):
        raise JailError("Mall Cop working directory is outside the per-run jail area")
    if not command or command[0] != "/bin/codex":
        raise JailError("Mall Cop jail may execute only the bundled Codex binary")

    command_path = jail_root / command[0].lstrip("/")
    command_stat = command_path.lstat()
    if not stat.S_ISREG(command_stat.st_mode) or command_stat.st_uid != JAIL_OWNER_UID:
        raise JailError("Bundled jailed Codex executable is not a root-owned regular file")
    if command_stat.st_mode & 0o022 or not command_stat.st_mode & 0o111:
        raise JailError("Bundled jailed Codex executable has unsafe permissions")

    work_path = jail_root / cwd.lstrip("/")
    work_stat = work_path.lstat()
    if not stat.S_ISDIR(work_stat.st_mode) or stat.S_ISLNK(work_stat.st_mode):
        raise JailError("Mall Cop per-run work path must be a real directory")
    if (work_stat.st_uid, work_stat.st_gid) != (UNPRIVILEGED_UID, UNPRIVILEGED_GID):
        raise JailError("Mall Cop per-run work path has the wrong owner")
    if stat.S_IMODE(work_stat.st_mode) != 0o700:
        raise JailError("Mall Cop per-run work path must have mode 0700")


def set_no_new_privileges() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def enter_and_exec(jail_root: Path, cwd: str, command: list[str]) -> None:
    if os.geteuid() != 0:
        raise JailError("Mall Cop jail launcher must start as root")
    validate_jail(jail_root, cwd, command)

    os.chroot(jail_root)
    os.chdir(cwd)
    os.setgroups([])
    os.setgid(UNPRIVILEGED_GID)
    os.setuid(UNPRIVILEGED_UID)
    set_no_new_privileges()

    # Keep only the already-scrubbed environment supplied by the image service.
    os.execve(command[0], command, dict(os.environ))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("jail_root", type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    command = arguments.command
    if command and command[0] == "--":
        command = command[1:]
    try:
        enter_and_exec(arguments.jail_root, arguments.cwd, command)
    except (JailError, OSError) as exc:
        print(f"Mall Cop jail refused to start: {exc}", file=sys.stderr)
        return 126
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
