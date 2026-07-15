import runpy
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
SOLAR = runpy.run_path(str(SCRIPTS / "solar-toolbox"))
MODBUS = runpy.run_path(str(SCRIPTS / "modbus-read"))


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


if __name__ == "__main__":
    unittest.main()
