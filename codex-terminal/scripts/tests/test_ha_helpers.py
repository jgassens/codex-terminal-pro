from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
HA_SITE_MEMORY = SCRIPTS / "ha-site-memory"
HA_TOOLBOX = SCRIPTS / "ha-toolbox"


def load_extensionless_script(name: str, path: Path):
    spec = importlib.util.spec_from_loader(
        name,
        importlib.machinery.SourceFileLoader(name, str(path)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ha_site_memory = load_extensionless_script("ha_site_memory_test_module", HA_SITE_MEMORY)
ha_toolbox = load_extensionless_script("ha_toolbox_test_module", HA_TOOLBOX)


class HaSiteMemoryTests(unittest.TestCase):
    def test_fetch_states_explicitly_disables_environment_proxies(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'[{"entity_id":"light.kitchen"}]'
        opener = mock.MagicMock()
        opener.open.return_value = response
        proxy_handler = object()

        with (
            mock.patch.object(ha_site_memory, "read_token", return_value="secret-token"),
            mock.patch.object(
                ha_site_memory.urllib.request,
                "ProxyHandler",
                return_value=proxy_handler,
            ) as proxy_handler_factory,
            mock.patch.object(
                ha_site_memory.urllib.request,
                "build_opener",
                return_value=opener,
            ) as opener_factory,
            mock.patch.dict(
                os.environ,
                {"HTTP_PROXY": "http://attacker.invalid:8080"},
                clear=False,
            ),
        ):
            states, status = ha_site_memory.fetch_states(timeout=7)

        proxy_handler_factory.assert_called_once_with({})
        opener_factory.assert_called_once_with(proxy_handler)
        request = opener.open.call_args.args[0]
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 7})
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertEqual(status, "ok:1")
        self.assertIn("light.kitchen", states)


class HaToolboxTests(unittest.TestCase):
    def test_sensitive_yaml_keys_are_excluded_from_aggregate_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory)
            (config / "configuration.yaml").write_text(
                "safe_integration:\n  enabled: true\n",
                encoding="utf-8",
            )
            (config / "secrets.yaml").write_text(
                "private_api_key: secret\nprivate_password: secret\n",
                encoding="utf-8",
            )

            def fake_read_yaml(path: Path):
                if path.name == "secrets.yaml":
                    return True, {
                        "private_api_key": "secret",
                        "private_password": "secret",
                    }
                return True, {"safe_integration": {"enabled": True}}

            output = io.StringIO()
            with (
                mock.patch.object(ha_toolbox, "read_yaml", side_effect=fake_read_yaml),
                redirect_stdout(output),
            ):
                status = ha_toolbox.audit_config(
                    SimpleNamespace(config=str(config), json=True, max_files=350)
                )

        self.assertEqual(status, 0)
        payload = json.loads(output.getvalue())
        self.assertIn("safe_integration", payload["root_keys"])
        self.assertNotIn("private_api_key", payload["root_keys"])
        self.assertNotIn("private_password", payload["root_keys"])


if __name__ == "__main__":
    unittest.main()
