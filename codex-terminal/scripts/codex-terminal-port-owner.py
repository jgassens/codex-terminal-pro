#!/usr/bin/env python3
"""Verify that a Linux process tree owns a listening TCP port.

Used before forwarding a browser OAuth callback to a loopback listener.  The
check is intentionally Linux-/proc-specific and fails closed anywhere that
cannot prove ownership.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path


SOCKET_LINK = re.compile(r"^socket:\[(\d+)\]$")


def process_parent(stat_text: str) -> int:
    # /proc/<pid>/stat wraps comm in parentheses; comm itself may contain
    # spaces or parentheses, so split only after the final closing parenthesis.
    closing = stat_text.rfind(")")
    if closing < 0:
        raise ValueError("malformed process stat")
    fields = stat_text[closing + 1 :].split()
    if len(fields) < 2:
        raise ValueError("malformed process stat")
    return int(fields[1])


def process_tree(root_pid: int, proc_root: Path = Path("/proc")) -> set[int]:
    parents: dict[int, int] = {}
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            parents[int(entry.name)] = process_parent(
                (entry / "stat").read_text(encoding="utf-8", errors="strict")
            )
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            continue

    if root_pid not in parents:
        return set()
    result = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in result and pid not in result:
                result.add(pid)
                changed = True
    return result


def listening_socket_inodes(port: int, proc_root: Path = Path("/proc")) -> set[str]:
    """Return IPv4 127.0.0.1 listeners for the exact callback port.

    The forwarding socket always connects to 127.0.0.1.  An IPv6-only or
    wildcard listener on the same numeric port cannot establish ownership of
    that connection and must not satisfy this check.
    """
    inodes: set[str] = set()
    try:
        lines = (proc_root / "net" / "tcp").read_text(encoding="ascii").splitlines()[1:]
    except (FileNotFoundError, PermissionError, UnicodeError):
        return inodes
    for line in lines:
        fields = line.split()
        if len(fields) < 10 or fields[3] != "0A":  # TCP_LISTEN
            continue
        try:
            local_address, local_port_hex = fields[1].rsplit(":", 1)
            local_port = int(local_port_hex, 16)
        except (ValueError, IndexError):
            continue
        if (
            local_address.upper() == "0100007F"
            and local_port == port
            and fields[9].isdigit()
        ):
            inodes.add(fields[9])
    return inodes


def process_socket_inodes(pid: int, proc_root: Path = Path("/proc")) -> set[str]:
    result: set[str] = set()
    try:
        entries = list((proc_root / str(pid) / "fd").iterdir())
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return result
    for entry in entries:
        try:
            target = os.readlink(entry)
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
            continue
        match = SOCKET_LINK.fullmatch(target)
        if match:
            result.add(match.group(1))
    return result


def tree_owns_listener(root_pid: int, port: int, proc_root: Path = Path("/proc")) -> bool:
    listeners = listening_socket_inodes(port, proc_root)
    if not listeners:
        return False
    for pid in process_tree(root_pid, proc_root):
        if process_socket_inodes(pid, proc_root) & listeners:
            return True
    return False


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: codex-terminal-port-owner.py PROCESS_PID PORT", file=sys.stderr)
        return 2
    try:
        root_pid = int(argv[1])
        port = int(argv[2])
    except ValueError:
        return 2
    if root_pid <= 1 or not 1 <= port <= 65535:
        return 2
    try:
        return 0 if tree_owns_listener(root_pid, port) else 1
    except (FileNotFoundError, PermissionError, OSError, ValueError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
