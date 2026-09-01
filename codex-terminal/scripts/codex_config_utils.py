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
    """Serialize bundled mutators.

    An external writer may ignore this advisory lock. Atomic writers therefore
    also compare their source revision immediately before replacement and abort
    rather than knowingly overwriting a concurrent change.
    """
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
            text = handle.read(MAX_CONFIG_BYTES + 1)
            if len(text.encode("utf-8")) > MAX_CONFIG_BYTES:
                raise ValueError("Codex config is too large")
            return text
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def validate_toml(text: str) -> None:
    tomllib.loads(text or "")


def _scan_toml_multiline_state(line: str, state: str | None) -> str | None:
    """Return the multiline-string delimiter still open after one TOML line.

    The config mutators preserve comments and formatting instead of re-rendering
    parsed TOML, so they need a small amount of lexical context to distinguish a
    real table/key line from identical-looking text inside a multiline string.
    Input is parse-validated with tomllib before mutation; this scanner only
    supplies that context and deliberately does not try to be a second parser.
    """
    index = 0
    single_line_quote: str | None = None

    while index < len(line):
        if state is not None:
            if line.startswith(state, index):
                state = None
                index += 3
                continue
            if state == '"""' and line[index] == "\\":
                # In a multiline basic string, an escaped quote cannot close the
                # string. Skipping the escaped character also handles an even
                # backslash pair before a real delimiter correctly.
                index += 2
                continue
            index += 1
            continue

        if single_line_quote is not None:
            if single_line_quote == '"' and line[index] == "\\":
                index += 2
                continue
            if line[index] == single_line_quote:
                single_line_quote = None
            index += 1
            continue

        if line.startswith('"""', index):
            state = '"""'
            index += 3
        elif line.startswith("'''", index):
            state = "'''"
            index += 3
        elif line[index] in {'"', "'"}:
            single_line_quote = line[index]
            index += 1
        elif line[index] == "#":
            break
        else:
            index += 1

    return state


def iter_toml_lines(text: str) -> Iterator[tuple[str, bool]]:
    """Yield each line and whether it begins outside a multiline string."""
    state: str | None = None
    for line in text.splitlines(keepends=True):
        structural = state is None
        yield line, structural
        state = _scan_toml_multiline_state(line, state)


def assert_config_unchanged(path: Path, expected_text: str) -> None:
    if read_config(path) != expected_text:
        raise ValueError("config changed while it was being updated; retry")


def write_atomic_validated(
    path: Path,
    text: str,
    mode: int | None = None,
    *,
    expected_text: str | None = None,
) -> None:
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
        if expected_text is not None:
            assert_config_unchanged(path, expected_text)
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
