#!/usr/bin/env python3
"""Dev server that disables caching — no more Cmd+Shift+R."""

import http.server

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    http.server.test(HandlerClass=NoCacheHandler, port=8000)
