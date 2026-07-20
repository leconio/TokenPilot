"""Small content-free OpenAI-compatible model service for the native example."""

from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class FakeModelHandler(BaseHTTPRequestHandler):
    server_version = "TokenPilotFakeModel/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": {"code": "NOT_FOUND"}})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self._json(HTTPStatus.NOT_FOUND, {"error": {"code": "NOT_FOUND"}})
            return
        body = self._request_json()
        model = str(body.get("model", "unknown"))
        if model.endswith("local-primary"):
            self._json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "error": {
                        "message": "Primary model unavailable in the local example",
                        "type": "service_unavailable",
                        "code": "LOCAL_PRIMARY_UNAVAILABLE",
                    }
                },
            )
            return
        self._json(
            HTTPStatus.OK,
            {
                "id": f"chatcmpl-{model.replace('/', '-')}",
                "object": "chat.completion",
                "created": 1_784_352_000,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "local example result"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 120,
                    "completion_tokens": 30,
                    "total_tokens": 150,
                    "prompt_tokens_details": {"cached_tokens": 40},
                    "completion_tokens_details": {"reasoning_tokens": 5},
                },
            },
        )

    def _request_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("content-length", "0"))
            parsed = json.loads(self.rfile.read(length))
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, json.JSONDecodeError):
            return {}

    def _json(self, status: HTTPStatus, body: object) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status.value)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        del format, args


def create_server(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), FakeModelHandler)


if __name__ == "__main__":
    server = create_server(port=4101)
    print("Fake model service listening at http://127.0.0.1:4101", flush=True)
    server.serve_forever()
