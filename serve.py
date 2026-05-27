#!/usr/bin/env python3
"""serve.py — Local dev server for the dashboard.

Like `python3 -m http.server`, but sends no-store cache headers so a normal
browser refresh always shows the latest code and scan results. The stdlib
server sends no cache headers at all, so browsers cache app.js / styles.css
and you have to hard-reload (or use a private window) to see changes.

Usage:  python3 serve.py [port]      (default port 8000)
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
DASHBOARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DASHBOARD, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Dashboard on http://localhost:{PORT}  (no-cache; Ctrl+C to stop)")
    httpd.serve_forever()
