"""Shared, locked, parse-validated Codex config mutation helpers."""

from __future__ import annotations

import contextlib
import fcntl
import os
import stat
import tempfile
import tomllib
from pathlib import Path
from typing import Iterator


LOCK_FILENAME = ".codex-terminal-config.lock"
MAX_CONFIG_BYTES = 8 * 1024 * 1024
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)


@contextlib.contextmanager
def locked_config(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    parent_stat = path.parent.lstat()
    if not stat.S_ISDIR(parent_stat.st_mode) or stat.S_ISLNK(parent_stat.st_mode):
        raise ValueError("Codex config directory must not be a symlink")
    lock_path = path.parent / LOCK_FILENAME
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a+", encoding="utf-8") as lock_handle:
        lock_stat = os.fstat(lock_handle.fileno())
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
            raise ValueError("Codex config lock must be one regular file")
        os.fchmod(lock_handle.fileno(), 0o600)
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def read_config(path: Path) -> str:
    try:
        before = path.lstat()
    except FileNotFoundError:
        return ""
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ValueError("Codex config must be one regular non-linked file")
    if before.st_size > MAX_CONFIG_BYTES:
        raise ValueError("Codex config is too large")

    descriptor = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        current = os.fstat(descriptor)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_nlink != 1
            or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise ValueError("Codex config changed while it was being opened")
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = -1
            return handle.read(MAX_CONFIG_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def validate_toml(text: str) -> None:
    tomllib.loads(text or "")


def write_atomic_validated(path: Path, text: str, mode: int | None = None) -> None:
    validate_toml(text)
    if mode is None:
        try:
            existing = path.lstat()
            if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
                raise ValueError("Codex config destination must be one regular file")
            mode = stat.S_IMODE(existing.st_mode)
        except FileNotFoundError:
            mode = 0o644

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | DIRECTORY | NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def set_top_level_value(text: str, key: str, value: str) -> str:
    lines = text.splitlines(keepends=True)
    key_prefix = f"{key} = {value}\n"
    output: list[str] = []
    inserted = False
    in_table = False

    for line in lines:
        stripped = line.lstrip()
        if not in_table and stripped.startswith("["):
            if not inserted:
                output.extend([key_prefix, "\n"])
                inserted = True
            in_table = True

        if not in_table and not inserted:
            before_comment = line.split("#", 1)[0]
            if before_comment.strip().startswith(f"{key}"):
                left = before_comment.split("=", 1)
                if len(left) == 2 and left[0].strip() == key:
                    newline = "\r\n" if line.endswith("\r\n") else "\n"
                    output.append(f"{key} = {value}{newline}")
                    inserted = True
                    continue
        output.append(line)

    if not inserted:
        if output and not output[-1].endswith(("\n", "\r\n")):
            output[-1] += "\n"
        output.append(key_prefix)
    return "".join(output)
