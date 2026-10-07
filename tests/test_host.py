"""Network and lifecycle regressions, with no PS5 or external service needed."""
import importlib.util
import io
import pathlib
import socket
import ssl
import struct
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from contextlib import ExitStack
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("host", ROOT / "pc-host/host.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


def archive():
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as output:
        output.writestr("index.html", "embedded page")
    return zipfile.ZipFile(io.BytesIO(data.getvalue()))


def query(qtype=1, name="manuals.playstation.net"):
    labels = b"".join(bytes([len(part)]) + part.encode() for part in name.split("."))
    return struct.pack(">6H", 42, 0x100, 1, 0, 0, 0) + labels + b"\0" + struct.pack(">HH", qtype, 1)


class HostTests(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = pathlib.Path(self.resources.enter_context(tempfile.TemporaryDirectory()))
        self.base = self.root / "base"
        self.base.mkdir()
        self.overrides = self.root / "overrides"
        self.overrides.mkdir()

    def server(self, embedded=None, allowed=None, tls=False):
        server = host.build_http_server(
            "127.0.0.1", 0, str(self.base), str(self.overrides), allowed,
            embedded_zip=embedded, quiet=True, guide=host.GuideStatus(lambda _: None))
        self.resources.callback(server.server_close)
        if tls:
            cert, key = self.root / "cert.pem", self.root / "key.pem"
            host.generate_server_cert(str(cert), str(key))
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(
                server.socket, server_side=True, do_handshake_on_connect=False)
        host.start_server(server, self.resources)
        return server

    def fetch(self, server, path="/", method="GET", tls=False):
        scheme = "https" if tls else "http"
        url = f"{scheme}://127.0.0.1:{server.server_port}{path}"
        request = urllib.request.Request(url, method=method)
        context = ssl._create_unverified_context() if tls else None
        return urllib.request.urlopen(request, timeout=3, context=context)

    def test_embedded_uses_index_and_is_authoritative(self):
        embedded = self.resources.enter_context(archive())
        (self.overrides / "index.html").write_text("override")
        (self.base / "local.txt").write_text("not embedded")
        server = self.server(embedded)
        with patch.object(embedded, "namelist", side_effect=AssertionError("linear scan")):
            for path in ("/", "/app/index.html", "/document/en/ps5/index.html"):
                with self.fetch(server, path) as response:
                    self.assertEqual(response.read(), b"embedded page")
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.fetch(server, "/local.txt")
            self.assertEqual(error.exception.code, 404)
            error.exception.close()

    def test_local_priority_head_and_missing(self):
        (self.base / "index.html").write_text("base")
        (self.overrides / "index.html").write_text("override")
        server = self.server()
        with self.fetch(server) as response:
            self.assertEqual(response.read(), b"override")
        with self.fetch(server, method="HEAD") as response:
            self.assertEqual(response.read(), b"")
            self.assertEqual(response.headers["Content-Length"], "8")
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.fetch(server, "/missing")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()

    def test_symlink_cannot_escape_docroot(self):
        secret = self.root / "outside.txt"
        secret.write_text("outside docroot")
        (self.base / "escape.txt").symlink_to(secret)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.fetch(self.server(), "/escape.txt")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()

    def test_strict_host(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.fetch(self.server(allowed="manuals.playstation.net"))
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_idle_tls_peer_does_not_block_other_clients(self):
        (self.base / "index.html").write_text("TLS works")
        server = self.server(tls=True)
        idle = socket.create_connection(server.server_address, timeout=3)
        self.resources.callback(idle.close)
        with self.fetch(server, tls=True) as response:
            self.assertEqual(response.read(), b"TLS works")

    def test_default_update_check_starts_and_closes_cleanly(self):
        args = ["--base", str(self.base), "--no-dns", "--no-https", "--http-port", "0"]
        real_start = host.start_server
        servers = []
        def start(server, resources):
            servers.append(server)
            real_start(server, resources)
        with patch.object(host, "show_splash"), patch.object(host, "start_server", start):
            with patch.object(host.threading.Event, "wait", side_effect=KeyboardInterrupt):
                # Mocking Event.wait also affects Thread.start, so exercise the
                # lifecycle with a synchronous serve_forever stub instead.
                with patch.object(host.threading, "Thread"):
                    with patch.object(host.HostHTTPServer, "shutdown"):
                        self.assertEqual(host.main(args), 0)
        self.assertEqual(len(servers), 1)
        self.assertEqual(servers[0].socket.fileno(), -1)

    def test_https_failure_closes_previously_started_http(self):
        args = ["--base", str(self.base), "--no-dns", "--http-port", "0", "--https-port", "0"]
        servers = []
        build = host.build_http_server
        def capture(*args, **kwargs):
            server = build(*args, **kwargs)
            servers.append(server)
            return server
        with patch.object(host, "show_splash"), patch.object(host, "get_server_cert", return_value=(None, None)):
            with patch.object(host, "build_http_server", capture):
                self.assertEqual(host.main(args), 1)
        self.assertEqual(len(servers), 2)
        self.assertTrue(all(server.socket.fileno() == -1 for server in servers))

    def test_disabled_update_checker_has_no_worker(self):
        checker = host.UpdateChecker("1.0.0")
        checker.start()
        self.assertTrue(checker.done)
        self.assertIsNone(checker.thread)
        self.assertIsNone(checker.notice())

    def test_dns_record_types_and_nxdomain(self):
        for qtype, answers in ((1, 1), (28, 0), (16, 0), (255, 1)):
            qid, question, name = host.parse_query(query(qtype))
            self.assertEqual(name, host.DEFAULT_TARGET)
            reply = host.build_response(qid, question, "127.0.0.1")
            self.assertEqual(struct.unpack(">6H", reply[:12])[3], answers)
        reply = host.build_response(qid, question)
        self.assertEqual(struct.unpack(">6H", reply[:12])[1] & 15, 3)

    def test_dns_rejects_malformed_packets(self):
        for data in (b"", query()[:-1], query()[:12] + b"\xc0\x0c\0\1\0\1",
                     query()[:12] + b"\x40" + b"a" * 64 + b"\0\0\1\0\1"):
            self.assertIsNone(host.parse_query(data))
        self.assertIsNone(host.parse_query(query()[:4] + b"\0\2" + query()[6:]))

    def test_invalid_ip_is_an_argparse_error(self):
        with self.assertRaises(SystemExit) as error:
            host.parse_args(["--ip", "not-an-ip"])
        self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
