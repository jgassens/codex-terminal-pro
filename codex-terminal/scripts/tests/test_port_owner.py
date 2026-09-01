from __future__ import annotations

import os
import runpy
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
PORT_OWNER = runpy.run_path(str(SCRIPTS / "codex-terminal-port-owner.py"))


class PortOwnerTests(unittest.TestCase):
    def make_proc(self, root: Path) -> Path:
        proc = root / "proc"
        (proc / "net").mkdir(parents=True)
        (proc / "net" / "tcp").write_text(
            "sl local_address rem_address st tx_queue tr retr uid timeout inode\n",
            encoding="ascii",
        )
        (proc / "net" / "tcp6").write_text(
            "sl local_address rem_address st tx_queue tr retr uid timeout inode\n",
            encoding="ascii",
        )
        return proc

    def add_process(self, proc: Path, pid: int, parent: int, sockets: tuple[int, ...] = ()) -> None:
        process = proc / str(pid)
        (process / "fd").mkdir(parents=True)
        (process / "stat").write_text(
            f"{pid} (worker with ) chars) S {parent} 0 0 0 0\n",
            encoding="utf-8",
        )
        for index, inode in enumerate(sockets):
            os.symlink(f"socket:[{inode}]", process / "fd" / str(index + 3))

    def add_listener(self, proc: Path, port: int, inode: int, *, ipv6: bool = False) -> None:
        table = proc / "net" / ("tcp6" if ipv6 else "tcp")
        address = "00000000000000000000000001000000" if ipv6 else "0100007F"
        with table.open("a", encoding="ascii") as handle:
            handle.write(
                f"0: {address}:{port:04X} 00000000:0000 0A "
                f"00000000:00000000 00:00000000 00000000 0 0 {inode} 1\n"
            )

    def test_descendant_listener_is_owned_by_the_verified_process_tree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            proc = self.make_proc(Path(directory))
            self.add_process(proc, 100, 1)
            self.add_process(proc, 101, 100, (12345,))
            self.add_listener(proc, 1455, 12345)

            self.assertTrue(PORT_OWNER["tree_owns_listener"](100, 1455, proc))

    def test_unrelated_listener_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            proc = self.make_proc(Path(directory))
            self.add_process(proc, 100, 1)
            self.add_process(proc, 200, 1, (12345,))
            self.add_listener(proc, 1455, 12345)

            self.assertFalse(PORT_OWNER["tree_owns_listener"](100, 1455, proc))

    def test_ipv6_only_listener_cannot_authorize_an_ipv4_connection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            proc = self.make_proc(Path(directory))
            self.add_process(proc, 100, 1, (9876,))
            self.add_listener(proc, 1455, 9876, ipv6=True)

            self.assertFalse(PORT_OWNER["tree_owns_listener"](100, 1455, proc))

    def test_ipv6_owner_does_not_mask_an_unrelated_ipv4_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            proc = self.make_proc(Path(directory))
            self.add_process(proc, 100, 1, (1111,))
            self.add_process(proc, 200, 1, (2222,))
            self.add_listener(proc, 1455, 1111, ipv6=True)
            self.add_listener(proc, 1455, 2222)

            self.assertFalse(PORT_OWNER["tree_owns_listener"](100, 1455, proc))
            self.assertTrue(PORT_OWNER["tree_owns_listener"](200, 1455, proc))

    def test_cli_rejects_pid_one_and_invalid_ports(self) -> None:
        self.assertEqual(PORT_OWNER["main"](["helper", "1", "1455"]), 2)
        self.assertEqual(PORT_OWNER["main"](["helper", "100", "0"]), 2)
        self.assertEqual(PORT_OWNER["main"](["helper", "not-a-pid", "1455"]), 2)


if __name__ == "__main__":
    unittest.main()
