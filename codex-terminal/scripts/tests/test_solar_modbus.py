import argparse
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
SOLAR = runpy.run_path(str(SCRIPTS / "solar-toolbox"))
MODBUS = runpy.run_path(str(SCRIPTS / "modbus-read"))
MODBUS_SCAN = runpy.run_path(str(SCRIPTS / "modbus-scan"))


class SolarAuditSafetyTests(unittest.TestCase):
    def test_ct_keyword_is_word_aware(self):
        matches = SOLAR["text_matches_keywords"]
        self.assertFalse(matches("scripts.yaml"))
        self.assertFalse(matches("select an entity"))
        self.assertTrue(matches("CT clamp orientation"))
        self.assertTrue(matches("sensor.ct_power"))

    def test_config_scan_redacts_credentials(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            (root / "configuration.yaml").write_text(
                "solar_api_key: super-secret-value\n"
                "authorization: Bearer abcdef123456 # solar\n"
                "cloud_token: github_pat_should_not_escape # pv\n"
                "secret_ref: !secret pv_password # token=ghp_abcdefghijklmnopqrstuvwxyz\n"
                "mqtt_url: mqtt://solar-user:uri-super-secret@broker.local\n"
                "description: Solar production meter\n",
                encoding="utf-8",
            )
            storage = root / ".storage"
            storage.mkdir()
            (storage / "energy").write_text(
                '{"api_key":"quoted-json-secret","description":"solar"}\n',
                encoding="utf-8",
            )
            matches = SOLAR["scan_text_files"](root, 20)

        rendered = "\n".join(str(match["text"]) for match in matches)
        self.assertNotIn("super-secret-value", rendered)
        self.assertNotIn("abcdef123456", rendered)
        self.assertNotIn("github_pat_should_not_escape", rendered)
        self.assertNotIn("pv_password", rendered)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", rendered)
        self.assertNotIn("uri-super-secret", rendered)
        self.assertNotIn("quoted-json-secret", rendered)
        self.assertIn("<redacted>", rendered)
        self.assertIn("Solar production meter", rendered)


class SolarTargetSafetyTests(unittest.TestCase):
    def test_huge_cidr_is_stopped_after_the_configured_number_of_hosts(self):
        with self.assertRaisesRegex(ValueError, "exceeds --max-hosts 3"):
            SOLAR["expand_targets"](["0.0.0.0/0"], 3)

    def test_explicit_host_lists_are_subject_to_the_same_cap(self):
        with self.assertRaisesRegex(ValueError, "exceeds --max-hosts 2"):
            SOLAR["expand_targets"](["inverter.local,meter.local", "gateway.local"], 2)

    def test_duplicate_targets_do_not_consume_the_cap_twice(self):
        self.assertEqual(
            SOLAR["expand_targets"](["inverter.local,inverter.local", "inverter.local"], 1),
            ["inverter.local"],
        )

    def test_probe_uses_family_agnostic_connection_for_ipv6(self):
        connection = mock.MagicMock()
        with mock.patch.object(
            SOLAR["socket"],
            "create_connection",
            return_value=connection,
        ) as create_connection:
            result = SOLAR["probe"]("::1", 502, 0.25)

        create_connection.assert_called_once_with(("::1", 502), timeout=0.25)
        self.assertEqual(
            result,
            {
                "host": "::1",
                "port": 502,
                "open": True,
                "hint": "Modbus TCP / SunSpec Modbus",
            },
        )

    def test_discovery_rejects_nonfinite_timeouts_before_network_access(self):
        for timeout in (float("nan"), float("inf"), float("-inf")):
            args = argparse.Namespace(
                timeout=timeout,
                workers=1,
                max_hosts=1,
                ports="502",
                targets=["::1"],
                open_only=False,
                json=True,
            )
            with self.subTest(timeout=timeout), self.assertRaisesRegex(ValueError, "finite"):
                SOLAR["run_discover"](args)


class ModbusScanSafetyTests(unittest.TestCase):
    def test_explicit_targets_share_the_final_deduplicated_cap(self):
        expand = MODBUS_SCAN["expand_targets"]
        self.assertEqual(
            expand(["inverter.local,inverter.local", "meter.local"], 2),
            ["inverter.local", "meter.local"],
        )
        with self.assertRaisesRegex(ValueError, "exceeds --max-hosts 2"):
            expand(["inverter.local,meter.local", "gateway.local"], 2)

    def test_large_ipv6_cidr_stops_at_the_configured_cap(self):
        with self.assertRaisesRegex(ValueError, "exceeds --max-hosts 2"):
            MODBUS_SCAN["expand_targets"](["2001:db8::/64"], 2)

    def test_probe_uses_family_agnostic_connection_for_ipv6(self):
        connection = mock.MagicMock()
        with mock.patch.object(
            MODBUS_SCAN["socket"],
            "create_connection",
            return_value=connection,
        ) as create_connection:
            result = MODBUS_SCAN["probe"]("::1", 502, 0.25)

        create_connection.assert_called_once_with(("::1", 502), timeout=0.25)
        self.assertEqual(result, {"host": "::1", "port": 502, "open": True})

    def test_nonfinite_timeout_is_rejected_before_scanning(self):
        for timeout in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(timeout=timeout), self.assertRaisesRegex(ValueError, "finite"):
                MODBUS_SCAN["validate_scan_options"](502, timeout, 1, 1)


class ModiconAddressSafetyTests(unittest.TestCase):
    def test_matching_reference_types_normalize(self):
        normalize = MODBUS["normalize_address"]
        self.assertEqual(normalize("holding", 40001, "modicon"), 0)
        self.assertEqual(normalize("input", 30005, "modicon"), 4)
        self.assertEqual(normalize("coil", 1, "modicon"), 0)

    def test_wrong_reference_type_is_rejected(self):
        normalize = MODBUS["normalize_address"]
        for kind, address in (("holding", 30001), ("input", 40001), ("coil", 10001)):
            with self.subTest(kind=kind, address=address):
                with self.assertRaisesRegex(ValueError, "does not belong"):
                    normalize(kind, address, "modicon")

    def test_read_cannot_cross_address_space_boundary(self):
        with self.assertRaisesRegex(ValueError, "exceeds"):
            MODBUS["validate_address_span"](0xFFFF, 2)

    def test_read_counts_respect_modbus_protocol_limits(self):
        validate = MODBUS["validate_read_count"]
        for kind, maximum in (
            ("holding", 125),
            ("input", 125),
            ("coil", 2000),
            ("discrete", 2000),
        ):
            with self.subTest(kind=kind, count=maximum):
                validate(kind, maximum)
            with self.subTest(kind=kind, count=maximum + 1):
                with self.assertRaisesRegex(ValueError, f"at most {maximum}"):
                    validate(kind, maximum + 1)

    def test_read_count_must_be_positive(self):
        for count in (0, -1):
            with self.subTest(count=count):
                with self.assertRaisesRegex(ValueError, "greater than zero"):
                    MODBUS["validate_read_count"]("holding", count)


class ModbusConnectionSafetyTests(unittest.TestCase):
    @staticmethod
    def args(**overrides):
        values = {
            "host": "192.168.50.25",
            "serial": None,
            "port": 502,
            "unit": 1,
            "timeout": 3.0,
            "baudrate": 9600,
            "bytesize": 8,
            "stopbits": 1,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_tcp_accepts_unit_255_but_not_values_outside_one_byte(self):
        MODBUS["validate_connection_args"](self.args(unit=255))
        for unit in (-1, 256):
            with self.subTest(unit=unit), self.assertRaisesRegex(ValueError, "TCP unit"):
                MODBUS["validate_connection_args"](self.args(unit=unit))

    def test_rtu_keeps_the_protocol_unit_limit(self):
        MODBUS["validate_connection_args"](
            self.args(host=None, serial="/dev/ttyUSB0", unit=247)
        )
        with self.assertRaisesRegex(ValueError, "RTU unit"):
            MODBUS["validate_connection_args"](
                self.args(host=None, serial="/dev/ttyUSB0", unit=255)
            )

    def test_tcp_port_and_timeout_are_bounded(self):
        for port in (0, 65536):
            with self.subTest(port=port), self.assertRaisesRegex(ValueError, "TCP port"):
                MODBUS["validate_connection_args"](self.args(port=port))
        for timeout in (0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaisesRegex(ValueError, "timeout"):
                MODBUS["validate_connection_args"](self.args(timeout=timeout))

    def test_tcp_host_rejects_empty_or_control_character_values(self):
        for host in ("", " inverter.local", "inverter.local\x00"):
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, "TCP host"):
                MODBUS["validate_connection_args"](self.args(host=host))

    def test_serial_settings_are_validated_before_client_startup(self):
        invalid = (
            ({"host": None, "serial": ""}, "serial device"),
            ({"host": None, "serial": " /dev/ttyUSB0"}, "serial device"),
            ({"host": None, "serial": "/dev/ttyUSB0\x7f"}, "serial device"),
            ({"host": None, "serial": "/dev/ttyUSB0", "baudrate": 0}, "baudrate"),
            ({"host": None, "serial": "/dev/ttyUSB0", "bytesize": 9}, "byte size"),
            ({"host": None, "serial": "/dev/ttyUSB0", "stopbits": 3}, "stop bits"),
        )
        for overrides, message in invalid:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, message):
                MODBUS["validate_connection_args"](self.args(**overrides))

    def test_internal_type_error_does_not_retry_the_modbus_read(self):
        calls = 0

        def broken_read(**_kwargs):
            nonlocal calls
            calls += 1
            raise TypeError("failure inside pymodbus")

        with self.assertRaisesRegex(TypeError, "inside pymodbus"):
            MODBUS["call_read"](broken_read, 0, 1, 1)

        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
