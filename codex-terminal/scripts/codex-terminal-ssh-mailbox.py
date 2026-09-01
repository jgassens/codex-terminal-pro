#!/usr/bin/env python3
"""Safely snapshot and publish files in the shared SSH mailbox.

The mailbox lives under /config, which is writable outside this add-on.  All
filesystem access therefore uses directory file descriptors plus O_NOFOLLOW so
that a mailbox entry cannot redirect the bridge into /data (or another path).
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import sys
import uuid
from pathlib import Path


REQUEST_NAME = re.compile(r"request\.[A-Za-z0-9_-]{1,80}\Z")
INPUT_LIMITS = {
    "ready": 1,
    "command": 256,
    "stdin": 1024 * 1024,
    "arg1": 4096,
}
OUTPUT_LIMIT = 8 * 1024 * 1024
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)


class UnsafeMailbox(RuntimeError):
    pass


def open_directory_without_symlinks(path: str) -> int:
    """Open an absolute directory path without following any component."""

    if not os.path.isabs(path):
        raise UnsafeMailbox("mailbox path must be absolute")

    fd = os.open("/", os.O_RDONLY | DIRECTORY | CLOEXEC)
    try:
        for component in Path(path).parts[1:]:
            if component in {"", ".", ".."}:
                raise UnsafeMailbox("mailbox path has an unsafe component")
            next_fd = os.open(
                component,
                os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
                dir_fd=fd,
            )
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise


def ensure_private_directory_without_symlinks(path: str) -> None:
    """Create and secure a directory without following any path symlink."""

    if not os.path.isabs(path):
        raise UnsafeMailbox("mailbox path must be absolute")

    components = Path(path).parts[1:]
    if not components:
        raise UnsafeMailbox("refusing to change permissions on the filesystem root")

    fd = os.open("/", os.O_RDONLY | DIRECTORY | CLOEXEC)
    try:
        for component in components:
            if component in {"", ".", ".."}:
                raise UnsafeMailbox("mailbox path has an unsafe component")
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
                    dir_fd=fd,
                )
            except FileNotFoundError:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    # Another bridge instance may have created the directory
                    # between the failed open and mkdir.  Re-open it with
                    # O_NOFOLLOW instead of trusting the raced path.
                    pass
                next_fd = os.open(
                    component,
                    os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
                    dir_fd=fd,
                )
            os.close(fd)
            fd = next_fd

        info = os.fstat(fd)
        if info.st_uid != os.geteuid():
            raise UnsafeMailbox("mailbox directory has an unexpected owner")
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)


def prepare(args: argparse.Namespace) -> int:
    for path in args.paths:
        ensure_private_directory_without_symlinks(path)
    return 0


def request_name(request_root: str, request_dir: str) -> str:
    root = os.path.abspath(request_root)
    candidate = os.path.abspath(request_dir)
    if os.path.dirname(candidate) != root:
        raise UnsafeMailbox("request is not directly beneath the mailbox root")
    name = os.path.basename(candidate)
    if not REQUEST_NAME.fullmatch(name):
        raise UnsafeMailbox("request directory name is invalid")
    return name


def open_request(request_root: str, request_dir: str) -> tuple[int, int, str]:
    name = request_name(request_root, request_dir)
    root_fd = open_directory_without_symlinks(request_root)
    try:
        request_fd = os.open(
            name,
            os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
            dir_fd=root_fd,
        )
    except Exception:
        os.close(root_fd)
        raise

    request_stat = os.fstat(request_fd)
    if not stat.S_ISDIR(request_stat.st_mode):
        os.close(request_fd)
        os.close(root_fd)
        raise UnsafeMailbox("request entry is not a directory")
    if request_stat.st_uid != os.geteuid():
        os.close(request_fd)
        os.close(root_fd)
        raise UnsafeMailbox("request directory has an unexpected owner")
    if request_stat.st_mode & 0o077:
        os.close(request_fd)
        os.close(root_fd)
        raise UnsafeMailbox("request directory must have mode 0700")
    return root_fd, request_fd, name


def entry_stat(request_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=request_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def read_regular_file(
    request_fd: int,
    name: str,
    maximum: int,
    *,
    required: bool,
) -> bytes | None:
    before = entry_stat(request_fd, name)
    if before is None:
        if required:
            raise UnsafeMailbox(f"required mailbox file is missing: {name}")
        return None
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise UnsafeMailbox(f"mailbox input must be a regular non-linked file: {name}")
    if before.st_uid != os.geteuid():
        raise UnsafeMailbox(f"mailbox input has an unexpected owner: {name}")
    if before.st_mode & 0o022:
        raise UnsafeMailbox(f"mailbox input is writable by another user: {name}")
    if before.st_size > maximum:
        raise UnsafeMailbox(f"mailbox input is too large: {name}")

    fd = os.open(name, os.O_RDONLY | NOFOLLOW | CLOEXEC, dir_fd=request_fd)
    try:
        current = os.fstat(fd)
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
            raise UnsafeMailbox(f"mailbox input changed type: {name}")
        if current.st_dev != before.st_dev or current.st_ino != before.st_ino:
            raise UnsafeMailbox(f"mailbox input changed while opening: {name}")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > maximum:
            raise UnsafeMailbox(f"mailbox input is too large: {name}")
        return data
    finally:
        os.close(fd)


def write_private_file(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def snapshot(args: argparse.Namespace) -> int:
    root_fd, request_fd, _ = open_request(args.request_root, args.request_dir)
    try:
        if entry_stat(request_fd, "ready") is None:
            return 3
        read_regular_file(request_fd, "ready", INPUT_LIMITS["ready"], required=True)

        done = entry_stat(request_fd, "done")
        if done is not None:
            read_regular_file(request_fd, "done", INPUT_LIMITS["ready"], required=True)
            return 3

        command = read_regular_file(
            request_fd, "command", INPUT_LIMITS["command"], required=True
        )
        stdin = read_regular_file(
            request_fd, "stdin", INPUT_LIMITS["stdin"], required=False
        )
        arg1 = read_regular_file(
            request_fd, "arg1", INPUT_LIMITS["arg1"], required=False
        )

        assert command is not None
        try:
            command_text = command.decode("utf-8").removesuffix("\n")
        except UnicodeDecodeError as exc:
            raise UnsafeMailbox("command is not valid UTF-8") from exc
        if not command_text or any(char in command_text for char in "\r\n\0"):
            raise UnsafeMailbox("command must contain one non-empty line")

        work_dir = Path(args.work_dir)
        work_stat = work_dir.lstat()
        if not stat.S_ISDIR(work_stat.st_mode) or work_stat.st_uid != os.geteuid():
            raise UnsafeMailbox("work directory is unsafe")
        if work_stat.st_mode & 0o077:
            raise UnsafeMailbox("work directory must not be accessible by other users")

        write_private_file(work_dir / "command", command_text.encode("utf-8"))
        write_private_file(work_dir / "stdin", stdin or b"")
        if arg1 is not None:
            write_private_file(work_dir / "arg1", arg1)
        return 0
    finally:
        os.close(request_fd)
        os.close(root_fd)


def read_output(path: str) -> bytes:
    file_path = Path(path)
    info = file_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        raise UnsafeMailbox("bridge output is not a trusted regular file")
    if info.st_size > OUTPUT_LIMIT:
        raise UnsafeMailbox("bridge output is too large")
    with file_path.open("rb") as handle:
        data = handle.read(OUTPUT_LIMIT + 1)
    if len(data) > OUTPUT_LIMIT:
        raise UnsafeMailbox("bridge output is too large")
    return data


def atomic_write_at(request_fd: int, name: str, data: bytes) -> None:
    temporary = f".bridge-{name}-{uuid.uuid4().hex}"
    fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
        0o600,
        dir_fd=request_fd,
    )
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    except Exception:
        try:
            os.unlink(temporary, dir_fd=request_fd)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)
    os.replace(temporary, name, src_dir_fd=request_fd, dst_dir_fd=request_fd)


def publish(args: argparse.Namespace) -> int:
    try:
        exit_code = int(args.exit_code, 10)
    except ValueError as exc:
        raise UnsafeMailbox("exit code is invalid") from exc
    if exit_code < 0 or exit_code > 255:
        raise UnsafeMailbox("exit code is outside the supported range")

    response = read_output(args.response)
    stderr = read_output(args.stderr)
    root_fd, request_fd, _ = open_request(args.request_root, args.request_dir)
    try:
        atomic_write_at(request_fd, "response", response)
        atomic_write_at(request_fd, "stderr", stderr)
        atomic_write_at(request_fd, "exit_code", f"{exit_code}\n".encode())
        # The completion marker is always published last.
        atomic_write_at(request_fd, "done", b"")
        os.fsync(request_fd)
        return 0
    finally:
        os.close(request_fd)
        os.close(root_fd)


def cleanup(args: argparse.Namespace) -> int:
    root_fd = open_directory_without_symlinks(args.request_root)
    now = int(args.now)
    try:
        for name in os.listdir(root_fd):
            if not REQUEST_NAME.fullmatch(name):
                continue
            try:
                request_fd = os.open(
                    name,
                    os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC,
                    dir_fd=root_fd,
                )
            except (FileNotFoundError, NotADirectoryError, OSError):
                continue
            try:
                info = os.fstat(request_fd)
                done = entry_stat(request_fd, "done")
                # Only a regular completion marker proves that the bridge
                # finished the request.  A planted symlink, FIFO, or directory
                # must age out on the abandoned-request TTL instead of making
                # the poisoned request immortal.
                completed = done is not None and stat.S_ISREG(done.st_mode)
                ttl = args.done_ttl if completed else args.abandoned_ttl
                if now - int(info.st_mtime) < ttl:
                    continue
            finally:
                os.close(request_fd)

            try:
                shutil.rmtree(name, dir_fd=root_fd)
            except FileNotFoundError:
                pass
        return 0
    finally:
        os.close(root_fd)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subparsers = result.add_subparsers(dest="operation", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("paths", nargs="+")
    prepare_parser.set_defaults(function=prepare)

    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("request_root")
    snapshot_parser.add_argument("request_dir")
    snapshot_parser.add_argument("work_dir")
    snapshot_parser.set_defaults(function=snapshot)

    publish_parser = subparsers.add_parser("publish")
    publish_parser.add_argument("request_root")
    publish_parser.add_argument("request_dir")
    publish_parser.add_argument("response")
    publish_parser.add_argument("stderr")
    publish_parser.add_argument("exit_code")
    publish_parser.set_defaults(function=publish)

    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("request_root")
    cleanup_parser.add_argument("now", type=int)
    cleanup_parser.add_argument("done_ttl", type=int)
    cleanup_parser.add_argument("abandoned_ttl", type=int)
    cleanup_parser.set_defaults(function=cleanup)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        return args.function(args)
    except UnsafeMailbox as exc:
        print(f"Unsafe SSH mailbox request rejected: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"SSH mailbox operation failed safely: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
