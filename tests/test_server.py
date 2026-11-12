"""LAN launch and public-resource boundary checks (stdlib only)."""

import contextlib
import errno
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location("paper_server", Path(__file__).resolve().parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class QuietHandler(server.Handler):
    def log_message(self, *_args):
        pass


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for asset in server.ASSETS:
            target = self.root / asset.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("public asset " + asset, encoding="utf-8")
        self.root_patch = patch.object(server, "ROOT", self.root)
        self.root_patch.start()
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.httpd.lan_mode = False
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_port

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.root_patch.stop()
        self.temporary.cleanup()

    def request(self, route, method="GET"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, route)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_public_editor_assets_and_head_are_served(self):
        for route in sorted(server.ASSETS) + ["/", "/src/app.js?cache=test"]:
            with self.subTest(route=route):
                status, headers, body = self.request(route)
                self.assertEqual(status, 200)
                self.assertTrue(body.startswith(b"public asset "))
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertNotIn("unsafe-eval", headers["Content-Security-Policy"])
                head_status, head_headers, head_body = self.request(route, "HEAD")
                self.assertEqual(head_status, 200)
                self.assertEqual(head_body, b"")
                self.assertEqual(int(head_headers["Content-Length"]), len(body))

    def test_unlisted_files_directories_and_encoded_routes_are_not_shared(self):
        for name in [".git/config", ".release-keys/update-private.pem", ".cache/result.pdf", "answer.pdf", "src/private.js"]:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("PRIVATE_TEST_CONTENT_82b6a4", encoding="utf-8")
        for route in ["/.git/config", "/.release-keys/update-private.pem", "/.cache/result.pdf", "/answer.pdf", "/src/private.js", "/src/", "/vendor/", "/../server.py", "/%2e%2e/server.py", "/%252e%252e/server.py", "/src/%61pp.js", "/src/../index.html", "/src%5capp.js", "/%00index.html", "/%ff", "/package.json"]:
            with self.subTest(route=route):
                status, _headers, body = self.request(route)
                self.assertEqual(status, 403)
                self.assertNotIn(b"PRIVATE_TEST_CONTENT_82b6a4", body)
                self.assertEqual(self.request(route, "HEAD")[0], 403)

    def test_symlinks_to_private_files_or_directories_are_rejected(self):
        private = self.root / "private.txt"
        private.write_text("PRIVATE_TEST_CONTENT_82b6a4", encoding="utf-8")
        app = self.root / "src/app.js"
        app.unlink()
        try:
            app.symlink_to(private)
        except OSError as error:
            self.skipTest("Host does not permit creating symlinks: " + str(error))
        self.assertEqual(self.request("/src/app.js")[0], 403)
        app.unlink()
        outside = self.root / "other"
        outside.mkdir()
        (outside / "app.js").write_text("PRIVATE_TEST_CONTENT_82b6a4", encoding="utf-8")
        for path in (self.root / "src").iterdir():
            path.unlink()
        (self.root / "src").rmdir()
        (self.root / "src").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.request("/src/app.js")[0], 403)

    def test_health_distinguishes_loopback_from_lan_and_never_accepts_uploads(self):
        url = "http://127.0.0.1:{}/".format(self.port)
        self.assertTrue(server.is_running_editor(url))
        self.assertFalse(server.is_running_editor(url, require_lan=True))
        for lan in [False, True]:
            self.httpd.lan_mode = lan
            status, _headers, body = self.request("/health")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"app": server.APP_ID, "version": 2, "lan": lan})
            self.assertEqual(server.is_running_editor(url, require_lan=True), lan)
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]:
            status, headers, body = self.request("/index.html", method)
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "GET, HEAD")
            self.assertEqual(body, b"")


class LaunchTests(unittest.TestCase):
    def run_main(self, arguments, running=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(server, "print_access_urls") as urls, patch.object(server, "open_editor") as browser, patch.object(server, "ThreadingHTTPServer") as create:
            if running is not None:
                create.side_effect = OSError(errno.EADDRINUSE, "already used")
                def current(_url, require_lan=False):
                    return running == "lan" or (running == "local" and not require_lan)
                with patch.object(server, "is_running_editor", side_effect=current):
                    result = server.main(arguments)
            else:
                create.return_value.serve_forever.side_effect = KeyboardInterrupt
                result = server.main(arguments)
            return result, output.getvalue(), create, urls, browser

    def test_default_stays_loopback_and_explicit_lan_binds_all_ipv4(self):
        for args, address, lan in [(["--no-open"], ("127.0.0.1", 8766), False), (["--lan", "--port", "8767", "--no-open"], ("0.0.0.0", 8767), True)]:
            result, _output, create, urls, browser = self.run_main(args)
            self.assertEqual(result, 0)
            create.assert_called_once_with(address, server.Handler)
            self.assertIs(create.return_value.lan_mode, lan)
            urls.assert_called_once_with(address[1], lan)
            browser.assert_not_called()
            create.return_value.server_close.assert_called_once()

    def test_existing_local_service_cannot_be_reported_as_lan(self):
        result, output, _create, urls, browser = self.run_main(["--lan"], running="local")
        self.assertEqual(result, 1)
        self.assertIn("仅本机访问", output)
        self.assertIn("--lan --port 8767", output)
        urls.assert_not_called()
        browser.assert_not_called()
        result, output, _create, urls, browser = self.run_main(["--lan", "--no-open"], running="lan")
        self.assertEqual(result, 0)
        self.assertIn("已在运行", output)
        urls.assert_called_once_with(8766, True)
        browser.assert_not_called()
        result, output, _create, urls, _browser = self.run_main(["--lan", "--no-open"], running="other")
        self.assertEqual(result, 1)
        self.assertIn("其他程序", output)
        urls.assert_not_called()

    def test_private_address_discovery_is_ordered_filtered_and_offline(self):
        probe = MagicMock()
        probe.getsockname.return_value = ("10.0.0.12", 51000)
        with patch.object(server.socket, "socket") as socket_factory, patch.object(server, "interface_ipv4", return_value=["192.168.1.3", "10.0.0.12", "127.0.0.1", "169.254.1.2", "8.8.8.8", "bad"]):
            socket_factory.return_value.__enter__.return_value = probe
            self.assertEqual(server.lan_addresses(), ["10.0.0.12", "192.168.1.3"])
            probe.connect.assert_called_once_with(("192.0.2.1", 9))
            probe.send.assert_not_called()
            probe.sendto.assert_not_called()
        with patch.object(server.socket, "socket", side_effect=OSError), patch.object(server, "interface_ipv4", return_value=["192.168.1.3"]):
            self.assertEqual(server.lan_addresses(), ["192.168.1.3"])


if __name__ == "__main__":
    unittest.main()
