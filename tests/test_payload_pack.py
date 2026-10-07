import argparse
import hashlib
import importlib.util
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("payload_pack", ROOT / "tools/payload_pack.py")
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)


class PayloadPackTests(unittest.TestCase):
    def setUp(self):
        self.catalog = pack.load_catalog()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.data = b"\x7fELF" + b"test" * 100
        self.payload = dict(self.catalog["payloads"]["cheatrunner"],
                            size=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
        self.options = argparse.Namespace(output=self.root / "ps5_autoloader",
            cache=self.root / "cache", firmware="9.00", autoload=False, delay=None)

    def response(self, data=None):
        response = io.BytesIO(self.data if data is None else data)
        response.geturl = lambda: self.payload["url"]
        return response

    def test_dependencies_order_and_deduplication(self):
        result = pack.select_payloads(self.catalog, ["shadowmount", "kstuff-lite", "cheatrunner"])
        self.assertEqual(result, ["kstuff-lite", "shadowmount", "cheatrunner"])

    def test_bundled_services_cannot_be_duplicated(self):
        for key in ("kstuff-lite", "shadowmount", "cheatrunner"):
            with self.assertRaises(ValueError):
                pack.select_payloads(self.catalog, ["elf-arsenal", key])
        self.assertEqual(pack.select_payloads(self.catalog, ["elf-arsenal", "orbit-store"]),
                         ["elf-arsenal", "orbit-store"])

    def test_cycle_and_unknown_payload(self):
        self.catalog["payloads"]["kstuff-lite"]["requires"] = ["shadowmount"]
        for keys in (["shadowmount"], ["unknown"]):
            with self.assertRaises(ValueError):
                pack.select_payloads(self.catalog, keys)

    def test_cache_reuse_avoids_network(self):
        with patch.object(pack.urllib.request, "urlopen", return_value=self.response()) as request:
            first = pack.fetch(self.payload, self.options.cache)
            second = pack.fetch(self.payload, self.options.cache)
        self.assertEqual(first, second)
        self.assertEqual(first.read_bytes(), self.data)
        self.assertEqual(request.call_count, 1)

    def test_bad_checksum_or_oversize_never_publishes(self):
        for data in (b"x" * len(self.data), self.data + b"x"):
            with patch.object(pack.urllib.request, "urlopen", return_value=self.response(data)):
                with self.assertRaises(ValueError):
                    pack.build_pack([self.payload], self.options)
            self.assertFalse(self.options.output.exists())
            self.assertEqual(list(self.options.cache.iterdir()), [])

    def test_download_only_does_not_enable_autoload(self):
        with patch.object(pack.urllib.request, "urlopen", return_value=self.response()):
            pack.build_pack([self.payload], self.options)
        self.assertFalse((self.options.output / "autoload.txt").exists())
        self.assertTrue((self.options.output / "autoload.example.txt").is_file())

    def test_opt_in_pack_and_existing_directory_preserved(self):
        self.options.autoload = True
        with patch.object(pack.urllib.request, "urlopen", return_value=self.response()):
            pack.build_pack([self.payload], self.options)
        config = self.options.output / "autoload.txt"
        before = config.read_bytes()
        self.assertIn(b"CheatRunner.elf\n", before)
        with self.assertRaises(ValueError):
            pack.build_pack([self.payload], self.options)
        self.assertEqual(config.read_bytes(), before)

    def test_firmware_range_and_delay_order(self):
        for value in ("6.00", "14.00", "9.0", "nan"):
            with self.assertRaises(argparse.ArgumentTypeError):
                pack.firmware(value)
        self.assertEqual(pack.firmware("9.00"), "9.00")
        payloads = [self.catalog["payloads"][key] for key in ("kstuff-lite", "shadowmount")]
        self.assertTrue(pack.autoload_text(payloads, None).endswith(
            "kstuff.elf\n!5000\nshadowmountplus.elf\n"))
        self.assertIn("!9000", pack.autoload_text(payloads, 9000))
