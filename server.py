#!/usr/bin/env python3
"""Serve the handwriting editor on this computer without accepting uploads."""

import argparse
import errno
import io
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import ProxyHandler, build_opener
import webbrowser


ROOT = Path(__file__).resolve().parent
APP_ID = "local-pdf-handwriting"
CSP = (
    "default-src 'none'; "
    "script-src 'self' blob: 'unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; font-src 'self' blob: data:; "
    "connect-src 'self' blob: data:; worker-src 'self' blob:; "
    "object-src 'none'; frame-src 'none'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)


def served_path(url_path):
    """Reject traversal and symlinks pointing outside the application folder."""
    path = unquote(urlsplit(url_path).path)
    if "\x00" in path or "\\" in path or ".." in path.split("/"):
        return None
    target = (ROOT / path.lstrip("/")).resolve()
    try:
        target.relative_to(ROOT)
    except ValueError:
        return None
    return target


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
        if urlsplit(self.path).path == "/health":
            payload = json.dumps({"app": APP_ID, "version": 1}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            return io.BytesIO(payload)
        if served_path(self.path) is None:
            self.send_error(403, "Path outside application folder")
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


def is_running_editor(url):
    # A localhost health check must not use a system-configured HTTP proxy.
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(url + "health", timeout=1) as response:
            data = json.loads(response.read(4096))
        return isinstance(data, dict) and data.get("app") == APP_ID
    except (OSError, ValueError):
        return False


def open_editor(url):
    try:
        if not webbrowser.open(url):
            print("请在浏览器中打开：" + url, flush=True)
    except webbrowser.Error:
        print("请在浏览器中打开：" + url, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动本地 PDF 手写答题工具")
    parser.add_argument("--port", type=int, default=8766, help="本机端口，默认 8766")
    parser.add_argument("--no-open", action="store_true", help="只启动服务，不打开浏览器")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口须在 1 到 65535 之间")
    url = "http://127.0.0.1:{}/".format(args.port)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            if is_running_editor(url):
                print("手写答题工具已在运行：" + url, flush=True)
                if not args.no_open:
                    open_editor(url)
                return 0
            print(
                "端口 {} 已被其他程序占用。请用 --port 8767 等其他端口启动；"
                "不会结束现有程序。".format(args.port),
                flush=True,
            )
        else:
            print("无法启动本地服务：{}".format(error), flush=True)
        return 1
    print("本地 PDF 手写答题：" + url, flush=True)
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
