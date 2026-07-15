#!/usr/bin/env python3
"""Safely read and atomically publish direct files in the /config mount.

The Home Assistant configuration mount is writable outside this add-on.  A
plain shell redirect or ``cp`` therefore must not follow a pre-created symlink
from a managed filename into /data or another mounted path.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
import uuid
from pathlib import Path


CONFIG_ROOT = os.environ.get("CODEX_TERMINAL_CONFIG_ROOT", "/config")
MAX_FILE_SIZE = 8 * 1024 * 1024
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)


class UnsafeConfigFile(RuntimeError):
    """Raised when a path can escape or redirect access outside /config."""


def validate_direct_name(name: str) -> str:
    if (
        not name
        or name in {".", ".."}
        or os.path.basename(name) != name
        or "/" in name
        or "\0" in name
    ):
        raise UnsafeConfigFile("managed config filename must be one direct basename")
    return name


def open_directory_without_symlinks(path: str) -> int:
    if not os.path.isabs(path):
        raise UnsafeConfigFile("config root must be absolute")

    descriptor = os.open("/", os.O_RDONLY | DIRECTORY | CLOEXEC)
    try:
        for component in Path(path).parts[1:]:
            if component in {"", ".", ".."}:
                raise UnsafeConfigFile("config root has an unsafe component")
            next_descriptor = os.open(
                component,
                os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def read_regular_path(path: str) -> bytes:
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise UnsafeConfigFile("publish source must be one regular non-linked file")
    if before.st_uid != os.geteuid():
        raise UnsafeConfigFile("publish source has an unexpected owner")
    if before.st_size > MAX_FILE_SIZE:
        raise UnsafeConfigFile("publish source is too large")

    descriptor = os.open(path, os.O_RDONLY | NOFOLLOW | CLOEXEC)
    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
            raise UnsafeConfigFile("publish source changed type while opening")
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise UnsafeConfigFile("publish source changed while opening")
        return read_bounded(descriptor)
    finally:
        os.close(descriptor)


def read_bounded(descriptor: int) -> bytes:
    chunks: list[bytes] = []
    remaining = MAX_FILE_SIZE + 1
    while remaining > 0:
        chunk = os.read(descriptor, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b"".join(chunks)
    if len(data) > MAX_FILE_SIZE:
        raise UnsafeConfigFile("managed config file is too large")
    return data


def write_all(descriptor: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("short write while publishing managed config file")
        remaining = remaining[written:]


def snapshot(name: str, destination: str) -> int:
    name = validate_direct_name(name)
    root_descriptor = open_directory_without_symlinks(CONFIG_ROOT)
    source_descriptor: int | None = None
    destination_descriptor: int | None = None
    try:
        try:
            before = os.stat(name, dir_fd=root_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return 3
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise UnsafeConfigFile("managed config input must be a regular non-linked file")
        if before.st_size > MAX_FILE_SIZE:
            raise UnsafeConfigFile("managed config input is too large")

        source_descriptor = os.open(
            name,
            os.O_RDONLY | NOFOLLOW | CLOEXEC,
            dir_fd=root_descriptor,
        )
        current = os.fstat(source_descriptor)
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
            raise UnsafeConfigFile("managed config input changed type while opening")
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise UnsafeConfigFile("managed config input changed while opening")
        data = read_bounded(source_descriptor)

        destination_before = os.lstat(destination)
        if (
            not stat.S_ISREG(destination_before.st_mode)
            or destination_before.st_nlink != 1
            or destination_before.st_uid != os.geteuid()
        ):
            raise UnsafeConfigFile("snapshot destination must be an owned regular file")
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | NOFOLLOW | CLOEXEC,
        )
        destination_current = os.fstat(destination_descriptor)
        if (destination_current.st_dev, destination_current.st_ino) != (
            destination_before.st_dev,
            destination_before.st_ino,
        ):
            raise UnsafeConfigFile("snapshot destination changed while opening")
        os.ftruncate(destination_descriptor, 0)
        write_all(destination_descriptor, data)
        os.fsync(destination_descriptor)
        return 0
    finally:
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        if source_descriptor is not None:
            os.close(source_descriptor)
        os.close(root_descriptor)


def publish(source: str, name: str, mode: int) -> int:
    name = validate_direct_name(name)
    if mode not in {0o600, 0o644, 0o700, 0o755}:
        raise UnsafeConfigFile("publish mode is not an approved managed-file mode")
    data = read_regular_path(source)
    root_descriptor = open_directory_without_symlinks(CONFIG_ROOT)
    temporary_name = f".{name}.codex-terminal.{uuid.uuid4().hex}.tmp"
    temporary_descriptor: int | None = None
    try:
        temporary_descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
            mode,
            dir_fd=root_descriptor,
        )
        os.fchmod(temporary_descriptor, mode)
        write_all(temporary_descriptor, data)
        os.fsync(temporary_descriptor)

        opened = os.fstat(temporary_descriptor)
        named = os.stat(
            temporary_name,
            dir_fd=root_descriptor,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISREG(named.st_mode)
            or named.st_nlink != 1
            or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)
        ):
            raise UnsafeConfigFile("temporary publish file changed before replacement")

        os.replace(
            temporary_name,
            name,
            src_dir_fd=root_descriptor,
            dst_dir_fd=root_descriptor,
        )
        os.fsync(root_descriptor)
        return 0
    finally:
        if temporary_descriptor is not None:
            os.close(temporary_descriptor)
        try:
            os.unlink(temporary_name, dir_fd=root_descriptor)
        except FileNotFoundError:
            pass
        os.close(root_descriptor)


def parse_mode(value: str) -> int:
    try:
        return int(value, 8)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("mode must be octal") from exc


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="action", required=True)

    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("name")
    snapshot_parser.add_argument("destination")

    publish_parser = subparsers.add_parser("publish")
    publish_parser.add_argument("source")
    publish_parser.add_argument("name")
    publish_parser.add_argument("mode", type=parse_mode)
    return result


def main() -> int:
    arguments = parser().parse_args()
    try:
        if arguments.action == "snapshot":
            return snapshot(arguments.name, arguments.destination)
        return publish(arguments.source, arguments.name, arguments.mode)
    except UnsafeConfigFile as exc:
        print(f"unsafe managed config file: {exc}", file=sys.stderr)
        return 4
    except OSError as exc:
        print(f"managed config file operation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
