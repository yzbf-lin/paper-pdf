#!/usr/bin/env python3
"""Serve only the editor assets, locally or on the LAN, without uploads."""

import argparse
import errno
import io
import ipaddress
import json
import re
import socket
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import ProxyHandler, build_opener
import webbrowser


ROOT = Path(__file__).resolve().parent
APP_ID = "local-pdf-handwriting"
ASSETS = frozenset({
    "/index.html", "/style.css", "/src/bootstrap.js", "/src/app.js",
    "/src/ink.js", "/src/pdf.js", "/src/preferences.js",
    "/vendor/pdf.min.js", "/vendor/pdf.worker.min.js", "/vendor/pdf-lib.min.js",
})
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
))
CSP = (
    "default-src 'none'; "
    "script-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; font-src 'self' blob: data:; "
    "connect-src 'self' blob: data:; worker-src 'self' blob:; "
    "object-src 'none'; frame-src 'none'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)


def request_path(url_path):
    try:
        parts = urlsplit(url_path)
        path = unquote(parts.path, errors="strict")
    except (UnicodeError, ValueError):
        return None
    if parts.scheme or parts.netloc or parts.fragment or path != parts.path:
        return None
    return path


def served_path(url_path):
    """Expose exactly the browser files, never repository files or documents."""
    path = request_path(url_path)
    if path == "/":
        path = "/index.html"
    if path not in ASSETS:
        return None
    target = ROOT
    for component in path.lstrip("/").split("/"):
        target = target / component
        # Even a symlink into ROOT could point at a private signing key.
        if target.is_symlink():
            return None
    try:
        target.resolve().relative_to(ROOT.resolve())
    except ValueError:
        return None
    return None if target.is_dir() else target


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_head(self):
        if request_path(self.path) == "/health":
            payload = json.dumps({"app": APP_ID, "version": 2,
                                  "lan": bool(getattr(self.server, "lan_mode", False))}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            return io.BytesIO(payload)
        if served_path(self.path) is None:
            self.send_error(403, "This resource is not shared")
            return None
        return super().send_head()

    def translate_path(self, path):
        # send_head validates the path before the base handler opens a file.
        return str(served_path(path) or ROOT / ".invalid-path")

    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

    def reject_write(self):
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = reject_write
    do_PUT = reject_write
    do_PATCH = reject_write
    do_DELETE = reject_write
    do_OPTIONS = reject_write
    do_TRACE = reject_write
    do_CONNECT = reject_write


def is_running_editor(url, require_lan=False):
    # A localhost health check must not use a system-configured HTTP proxy.
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(url + "health", timeout=1) as response:
            data = json.loads(response.read(4096))
        return (isinstance(data, dict) and data.get("app") == APP_ID
                and (not require_lan or data.get("lan") is True))
    except (OSError, ValueError):
        return False


def is_private_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
        return any(address in network for network in PRIVATE_NETWORKS)
    except ipaddress.AddressValueError:
        return False


def interface_ipv4():
    """Use OS interface inventory as a fallback; no third-party dependency."""
    if sys.platform == "darwin":
        command = ["/sbin/ifconfig"]
    elif sys.platform == "win32":
        command = ["ipconfig"]
    else:
        command = ["ip", "-4", "-o", "addr", "show", "up"]
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                errors="replace", timeout=2, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if sys.platform == "win32":
        return re.findall(r"IPv4[^:\r\n]*:\s*([0-9.]+)", result.stdout)
    return re.findall(r"\binet\s+([0-9.]+)", result.stdout)


def lan_addresses():
    candidates = []
    # UDP connect only asks the OS to select a route; no packet is sent.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))
            candidates.append(probe.getsockname()[0])
    except OSError:
        pass
    candidates.extend(interface_ipv4())
    return list(dict.fromkeys(value for value in candidates if is_private_ipv4(value)))


def print_access_urls(port, lan):
    print("本机访问：http://127.0.0.1:{}/".format(port), flush=True)
    if not lan:
        return
    addresses = lan_addresses()
    for address in addresses:
        print("手机访问（连接同一局域网）：http://{}:{}/".format(address, port), flush=True)
    if not addresses:
        print("未识别到局域网 IPv4 地址。请在系统网络设置中查看本机 IP，"
              "然后在手机打开 http://本机IP:{}/".format(port), flush=True)


def open_editor(url):
    try:
        if not webbrowser.open(url):
            print("请在浏览器中打开：" + url, flush=True)
    except webbrowser.Error:
        print("请在浏览器中打开：" + url, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动本地 PDF 手写答题工具")
    parser.add_argument("--port", type=int, default=8766, help="本机端口，默认 8766")
    parser.add_argument("--lan", action="store_true", help="允许同一局域网的手机访问")
    parser.add_argument("--no-open", action="store_true", help="只启动服务，不打开浏览器")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口须在 1 到 65535 之间")
    url = "http://127.0.0.1:{}/".format(args.port)
    try:
        server = ThreadingHTTPServer(("0.0.0.0" if args.lan else "127.0.0.1", args.port), Handler)
        server.lan_mode = args.lan
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            if is_running_editor(url, require_lan=args.lan):
                print("手写答题工具已在运行：" + url, flush=True)
                if args.lan:
                    print_access_urls(args.port, True)
                if not args.no_open:
                    open_editor(url)
                return 0
            alternate = 8768 if args.port == 8767 else 8767
            if args.lan and is_running_editor(url):
                print("端口 {} 上已有仅本机访问的服务，不能供手机连接。"
                      "请使用 --lan --port {}；不会停止现有服务。".format(args.port, alternate), flush=True)
            else:
                print("端口 {} 已被其他程序占用。请用 --port {} 等其他端口启动；"
                      "不会结束现有程序。".format(args.port, alternate), flush=True)
        else:
            print("无法启动本地服务：{}".format(error), flush=True)
        return 1
    print_access_urls(args.port, args.lan)
    print("文件在浏览器本机处理。保留此窗口；按 Ctrl+C 停止服务。", flush=True)
    if not args.no_open:
        open_editor(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n本地服务已停止。", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
